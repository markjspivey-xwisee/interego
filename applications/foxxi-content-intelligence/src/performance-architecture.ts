/**
 * Foxxi Performance Architecture — the contextualize → method spine.
 *
 * Traditional learning systems start with content ("here is a course").
 * This module starts with PERFORMANCE: a typed description of a
 * performer (human OR agent), the work they are doing, and what is
 * observed. Content is never assumed — it is one possible intervention,
 * selected (or ruled out) by the regime-appropriate method.
 *
 * The first principle is that the system does NOT begin by idealising a
 * future state and naming a gap to it. Idealising an exemplary state,
 * identifying the gap to observed performance, and closing that gap is
 * the method of ONE causality regime — the Knowable regime — not a
 * universal frame. So the universal first step is to CONTEXTUALIZE: read
 * the work's regime — how knowable the relationship between act and
 * outcome is — and only then route to that regime's method:
 *
 *   · Evident → apply the established practice. The right response is
 *     self-evident; there is nothing to analyse and no gap to close —
 *     recognise the situation and apply the known answer.
 *   · Knowable → gap analysis. Here, and only here, the situation is
 *     framed as a gap: an exemplary performance is established, observed
 *     performance is compared to it, a cause-factor analysis isolates
 *     why they differ, and an intervention closes the gap.
 *   · Emergent → a dispositional read (composes `agent-disposition.ts`):
 *     a complex, adaptive system has no exemplary state to close toward —
 *     only dispositions, propensities, and probes. You cannot instruct,
 *     or gap-analyse, your way through Emergent work.
 *   · Turbulent → stabilise first, then re-contextualize.
 *
 * The output is an InterventionPlan — the full *paradigm* of possible
 * interventions (instruction, performance-support, reference, coaching,
 * probe, environmental-fix, …), each marked selected or ruled-out with
 * its reasoning. The plan can conclude that no content should be built
 * at all: most performance situations turn out to be environmental, and
 * no course fixes a broken tool or a bad incentive.
 *
 * Emergent from Interego: a PerformanceSituation is a typed context
 * descriptor with a modal status; contextualizing is a composition over
 * the performer's disposition / record / work environment; the
 * intervention decision is a paradigmatic operation (the intervention
 * space is a paradigm set, the regime read supplies the constraints, the
 * selected intervention is the surviving cell). In the Knowable regime
 * the evaluation loop closes with `cg:supersedes` — a measured new
 * performance state supersedes the old.
 *
 * This is the project's own synthesis. It is informed by established
 * practice in performance improvement, instructional design, and
 * complexity-aware management, but introduces its own vocabulary and
 * model (see SOURCES-AND-ATTRIBUTION.md).
 *
 * Layer: L3 vertical. Composes the substrate; no L1/L2/L3 ontology
 * change. Domain terms are `foxxi:`-namespaced (see foxxi-vocab.ts).
 */

import { assessDisposition, type WorkRegime } from './agent-disposition.js';
import type { AgentTrajectory } from './agent-trajectory.js';

// ── Performers + directionality ─────────────────────────────────────

export type PerformerKind = 'human' | 'agent';

export interface Performer {
  /** Stable id — a DID for agents and wallet-rooted humans. */
  id: string;
  kind: PerformerKind;
  role?: string;
}

/**
 * The four directionalities of instruction / support. They are not a
 * taxonomy bolted on — they emerge from the Agent facet: author kind ×
 * audience kind.
 */
export type PerformanceDirection = 'H2H' | 'H2A' | 'A2H' | 'A2A';

export function directionOf(author: PerformerKind, audience: PerformerKind): PerformanceDirection {
  return `${author === 'human' ? 'H' : 'A'}2${audience === 'human' ? 'H' : 'A'}` as PerformanceDirection;
}

export function describeDirection(d: PerformanceDirection): string {
  switch (d) {
    case 'H2H': return 'human authors for a human audience — classic instructional design.';
    case 'H2A': return 'a human authors doctrine/policy an agent ingests as context — the "course" is a set of context descriptors, not slides.';
    case 'A2H': return 'an agent authors a job aid / micro-lesson for a human, typically in the flow of their work.';
    case 'A2A': return 'one agent composes a playbook (fragments + affordances) another agent consumes — agentic content generation.';
  }
}

// ── The performance situation ───────────────────────────────────────

export type SituationModalStatus = 'Hypothetical' | 'Asserted';

/**
 * A performance situation — the unit the system reasons from. It is a
 * performer, the work, and what is observed. Note what it does NOT
 * carry: an idealised "desired" state. A situation is not a gap. An
 * exemplary state is established later, and only if the work is
 * contextualized into the Knowable regime.
 */
export interface PerformanceSituation {
  id: string;
  performer: Performer;
  /** What the performer is doing — the work context. */
  workContext: string;
  /** The competency / behaviour in question. */
  competency: string;
  /** Observed performance, stated plainly — what is actually happening. */
  observed: string;
  /** How often the task occurs — informs instruction-vs-job-aid. */
  frequency: 'continuous' | 'frequent' | 'occasional' | 'rare';
  /** Consequence of poor performance. */
  criticality: 'low' | 'moderate' | 'high' | 'safety-critical';
  /**
   * Modal status of the situation CLAIM itself. A reported situation is
   * Hypothetical until measured; an assessment promotes it to Asserted.
   */
  modalStatus: SituationModalStatus;
  /** Where the signal came from (an LRS statement, a trajectory, a
   *  manager observation, a self-report). */
  provenance: string;
  /** The work regime, if the caller already knows it. */
  domain?: WorkRegime;
}

// ── The cause-analysis factor model (the Knowable regime) ───────────

/** One factor in the cause analysis. */
export interface FactorReading {
  factor: string;
  /** Environmental factors are the workplace's responsibility;
   *  individual factors are the performer's repertory. */
  category: 'environmental' | 'individual';
  adequate: boolean;
  evidence: string;
  /** If this factor is the deficiency, the intervention class it implies. */
  impliesIntervention: InterventionType;
}

/**
 * Six factors of performance — three environmental (the workplace's
 * responsibility) and three individual (the performer's repertory).
 * Environmental factors usually dominate and are cheaper to fix than
 * re-skilling people, so the analysis examines them first. This factor
 * model belongs to the Knowable regime's gap analysis.
 */
export interface PerformanceFactors {
  /** Environmental. */
  information: FactorReading;
  instrumentation: FactorReading;
  incentives: FactorReading;
  /** Individual. */
  knowledgeSkill: FactorReading;
  capacity: FactorReading;
  motives: FactorReading;
}

type FactorKey = keyof PerformanceFactors;

const FACTOR_TEMPLATE: Record<FactorKey, { category: FactorReading['category']; factor: string; implies: InterventionType }> = {
  information: { category: 'environmental', factor: 'Information — expectations, guidance, feedback', implies: 'performance-support' },
  instrumentation: { category: 'environmental', factor: 'Instrumentation — tools, resources, processes', implies: 'environmental-fix' },
  incentives: { category: 'environmental', factor: 'Incentives — consequences, rewards, alignment', implies: 'environmental-fix' },
  knowledgeSkill: { category: 'individual', factor: 'Knowledge & Skill — what the performer knows / can do', implies: 'instruction' },
  capacity: { category: 'individual', factor: 'Capacity — fit between performer and task demands', implies: 'environmental-fix' },
  motives: { category: 'individual', factor: 'Motives — does the performer want to perform', implies: 'coaching' },
};

// ── The intervention paradigm ───────────────────────────────────────

/**
 * The paradigm set of interventions. Instruction is one cell among
 * many; a healthy contextualization frequently selects something other
 * than "build a course".
 */
export type InterventionType =
  | 'instruction'          // curriculum/course/module/lesson — a real skill gap, needed from memory
  | 'performance-support'  // job aid / EPSS — delivered in the flow of work
  | 'reference'            // searchable knowledge — looked up, not "trained"
  | 'practice'             // deliberate practice / simulation — the skill exists, needs fluency
  | 'assessment'           // verify or certify — measure, do not teach
  | 'coaching'             // a feedback loop — transfer, motivation, the Emergent regime
  | 'probe'                // a safe-to-fail constraint probe — the Emergent regime
  | 'environmental-fix'    // tools / information / incentives — not a content deliverable
  | 'no-intervention';     // the situation is acceptable or self-resolving

export interface InterventionOption {
  type: InterventionType;
  selected: boolean;
  rationale: string;
  /** When ruled out, the honest reason. */
  ruledOutBecause?: string;
  /** When the intervention is content the system would author, the
   *  authoring affordance + the directionality it is authored in. */
  authoring?: { affordance: string; direction: PerformanceDirection };
}

// ── Contextualization — read the regime, then apply its method ──────

export type PerformanceMethod = 'apply-practice' | 'gap-analysis' | 'dispositional-read' | 'stabilise-first';

export interface Diagnosis {
  situationId: string;
  domain: WorkRegime;
  method: PerformanceMethod;
  /** For the gap-analysis method (Knowable) — the six-factor reading. */
  factors?: PerformanceFactors;
  /** For the gap-analysis method (Knowable) — the exemplary performance
   *  the observed state is compared against. Only the Knowable regime
   *  establishes an exemplary state; it is absent for every other. */
  exemplary?: string;
  /** The dominant deficiency factor(s) by name (Knowable). */
  rootCauses: string[];
  /**
   * The discriminating question (Knowable): could the performer perform
   * correctly under ideal conditions (full motivation, no obstacles)? If
   * yes, it is NOT a skill deficiency — and instruction is the wrong
   * intervention.
   */
  skillDeficiency: boolean;
  /** Whether the performer has performed this competency well before —
   *  decay of fluency rather than absence of the skill. */
  performedWellBefore?: boolean;
  /** For the dispositional method — the disposition read instead of a gap. */
  disposition?: { domain: WorkRegime; vector: string; stance: string; method: string };
  reasoning: string[];
  /** An honest note when the gap frame is the wrong one for this work. */
  caveat?: string;
}

export interface DiagnoseInput {
  situation: PerformanceSituation;
  /** The exemplary performance — what good looks like. It is only
   *  meaningful, and only used, when the work contextualizes into the
   *  Knowable regime; supplying it does not force that regime. */
  exemplary?: string;
  /** Evidence about the six performance factors — for the Knowable
   *  regime's gap analysis. Any factor not supplied is assumed adequate. */
  factorEvidence?: Partial<Record<FactorKey, { adequate: boolean; evidence: string }>>;
  /** Agent trajectories — for Emergent work, the dispositional read
   *  composes `agent-disposition.ts` off these. */
  trajectories?: readonly AgentTrajectory[];
  /** The discriminating question — could the performer perform correctly
   *  under ideal conditions? */
  couldPerformUnderIdealConditions?: boolean;
  /** Has the performer ever performed this competency well before? */
  performedWellBefore?: boolean;
}

/** Decide which method the work regime calls for. */
function methodForRegime(domain: WorkRegime): PerformanceMethod {
  if (domain === 'Emergent') return 'dispositional-read';
  if (domain === 'Turbulent') return 'stabilise-first';
  if (domain === 'Evident') return 'apply-practice';
  return 'gap-analysis'; // Knowable — the one regime the gap frame fits
}

/** Build the six-factor reading from supplied evidence (unsupplied = adequate). */
function buildFactors(evidence: DiagnoseInput['factorEvidence']): PerformanceFactors {
  const readFactor = (key: FactorKey): FactorReading => {
    const t = FACTOR_TEMPLATE[key];
    const e = evidence?.[key];
    return {
      factor: t.factor,
      category: t.category,
      adequate: e?.adequate ?? true,
      evidence: e?.evidence ?? 'no deficiency evidence supplied — assumed adequate.',
      impliesIntervention: t.implies,
    };
  };
  return {
    information: readFactor('information'),
    instrumentation: readFactor('instrumentation'),
    incentives: readFactor('incentives'),
    knowledgeSkill: readFactor('knowledgeSkill'),
    capacity: readFactor('capacity'),
    motives: readFactor('motives'),
  };
}

/**
 * Contextualize a performance situation. The universal first move is to
 * read the work regime; the method follows from it. Only the Knowable
 * regime frames the situation as a gap and runs a cause analysis.
 */
export function diagnose(input: DiagnoseInput): Diagnosis {
  const { situation } = input;

  // Determine the regime. Honour an explicit one; else, for an agent
  // with trajectories, read it off the disposition; else default to
  // Knowable (most structured workplace tasks live there).
  let domain: WorkRegime;
  if (situation.domain) {
    domain = situation.domain;
  } else if (situation.performer.kind === 'agent' && input.trajectories && input.trajectories.length > 0) {
    domain = assessDisposition(input.trajectories).regime.name;
  } else {
    domain = 'Knowable';
  }
  const method = methodForRegime(domain);
  const reasoning: string[] = [];

  // ── Emergent regime — refuse the gap frame, read disposition. ──
  if (method === 'dispositional-read') {
    const traj = input.trajectories ?? [];
    const disp = traj.length > 0 ? assessDisposition(traj) : null;
    reasoning.push('The work sits in the Emergent regime — a complex, adaptive system has dispositions and propensities, not a fixable gap. There is no exemplary state to idealise and close toward, so a gap analysis does not apply.');
    reasoning.push('Composing agent-disposition.ts: read the disposition and the vector of change, not a score against an ideal.');
    return {
      situationId: situation.id,
      domain,
      method,
      rootCauses: ['not applicable — the Emergent regime has no single fixable root cause'],
      skillDeficiency: false,
      ...(disp ? {
        disposition: {
          domain: disp.regime.name,
          vector: `${disp.vector.direction} — ${disp.vector.basis}`,
          stance: disp.regime.stance,
          method: disp.method,
        },
      } : {}),
      reasoning,
      caveat: 'The work is Emergent. Do NOT idealise a future state or build instruction toward one. Run safe-to-fail probes (agent-disposition.buildProbe), sense which cohere, and steer by vector.',
    };
  }

  // ── Turbulent regime — stabilise first. ──
  if (method === 'stabilise-first') {
    reasoning.push('The work sits in the Turbulent regime — behaviour is not yet patterned. No method can be applied until the situation is stabilised.');
    return {
      situationId: situation.id,
      domain,
      method,
      rootCauses: ['instability — there is no patterned behaviour to read'],
      skillDeficiency: false,
      reasoning,
      caveat: 'Act first to stabilise (act, then sense), THEN re-contextualize. Idealising a target state now would aim at one that does not yet exist.',
    };
  }

  // ── Evident regime — apply the established practice. ──
  if (method === 'apply-practice') {
    reasoning.push('The work sits in the Evident regime — the relationship between act and outcome is self-evident. There is no cause to analyse and no gap to close: recognise the situation and apply the established practice.');
    return {
      situationId: situation.id,
      domain,
      method,
      rootCauses: ['not applicable — the Evident regime applies a known, established response'],
      skillDeficiency: false,
      reasoning,
    };
  }

  // ── Knowable regime — gap analysis (the one regime the gap frame fits). ──
  const factors = buildFactors(input.factorEvidence);
  reasoning.push('The work sits in the Knowable regime — cause and effect are knowable through analysis. Here, and only here, the situation is framed as a gap: an exemplary performance is established, the observed performance is compared to it, and a cause-factor analysis isolates why they differ.');

  // Examine the environmental factors first — they account for most
  // performance gaps and are cheaper to fix than re-skilling people.
  const deficientFactors = (Object.keys(factors) as FactorKey[])
    .map(k => factors[k])
    .filter(c => !c.adequate);
  const envDeficient = deficientFactors.filter(c => c.category === 'environmental');
  const indDeficient = deficientFactors.filter(c => c.category === 'individual');

  // The discriminating question: is this genuinely a skill/knowledge
  // deficiency? If the performer could do it under ideal conditions, it
  // is not — instruction would teach what is already known.
  let skillDeficiency: boolean;
  if (input.couldPerformUnderIdealConditions === true) {
    skillDeficiency = false;
    reasoning.push('Discriminating question: the performer COULD perform under ideal conditions — therefore it is not a skill deficiency. Instruction will not help; look to incentives, tools, or expectations.');
  } else if (input.couldPerformUnderIdealConditions === false) {
    skillDeficiency = true;
    reasoning.push('Discriminating question: the performer could NOT perform even under ideal conditions — a genuine skill/knowledge deficiency.');
  } else {
    skillDeficiency = factors.knowledgeSkill.adequate === false;
    reasoning.push(`Discriminating question not answered directly; inferring from the Knowledge & Skill factor (${skillDeficiency ? 'deficient' : 'adequate'}).`);
  }

  const rootCauses: string[] = [];
  if (envDeficient.length > 0) {
    reasoning.push(`Environmental deficiencies found (${envDeficient.length}) — the workplace, not the performer, is the dominant lever. Fix these before considering instruction.`);
    rootCauses.push(...envDeficient.map(c => c.factor));
  }
  if (skillDeficiency) rootCauses.push(factors.knowledgeSkill.factor);
  if (indDeficient.some(c => c.factor.startsWith('Motives'))) rootCauses.push(factors.motives.factor);
  if (indDeficient.some(c => c.factor.startsWith('Capacity'))) rootCauses.push(factors.capacity.factor);
  if (rootCauses.length === 0) {
    rootCauses.push('no deficiency isolated — the gap may be acceptable variance, or the exemplary state may be mis-stated.');
  }

  const caveat = (!skillDeficiency && envDeficient.length === 0 && indDeficient.length === 0)
    ? 'No deficiency was isolated. Before building anything, re-check that the gap is real (assessment) and that the exemplary performance is correctly stated.'
    : undefined;

  return {
    situationId: situation.id,
    domain,
    method,
    factors,
    ...(input.exemplary !== undefined ? { exemplary: input.exemplary } : {}),
    rootCauses,
    skillDeficiency,
    ...(input.performedWellBefore !== undefined ? { performedWellBefore: input.performedWellBefore } : {}),
    reasoning,
    ...(caveat ? { caveat } : {}),
  };
}

// ── Intervention selection ──────────────────────────────────────────

const ALL_INTERVENTIONS: InterventionType[] = [
  'instruction', 'performance-support', 'reference', 'practice',
  'assessment', 'coaching', 'probe', 'environmental-fix', 'no-intervention',
];

/** The authoring affordance for an intervention that is authored content. */
function authoringFor(type: InterventionType, direction: PerformanceDirection): InterventionOption['authoring'] | undefined {
  switch (type) {
    case 'instruction': return { affordance: 'foxxi.compose_course', direction };
    case 'performance-support': return { affordance: 'foxxi.author_job_aid', direction };
    case 'reference': return { affordance: 'foxxi.author_reference', direction };
    case 'practice': return { affordance: 'foxxi.author_practice', direction };
    case 'assessment': return { affordance: 'foxxi.author_assessment', direction };
    default: return undefined; // coaching/probe/environmental-fix/no-intervention author no content
  }
}

export interface InterventionPlan {
  situationId: string;
  diagnosis: Diagnosis;
  /** The full paradigm — every option, selected or not, with reasoning. */
  paradigm: InterventionOption[];
  /** The selected intervention(s), in priority order. */
  selected: InterventionOption[];
  /** The headline answer to "does this situation need content built?" */
  contentWarranted: boolean;
  /** The directionality any authored content would be produced in. */
  direction: PerformanceDirection;
  summary: string;
}

export interface RecommendInput {
  diagnosis: Diagnosis;
  situation: PerformanceSituation;
  /** Who would author the intervention — defaults to an agent (the
   *  contextualizing agent itself authoring for the performer). */
  author?: Performer;
}

/**
 * Turn a regime read into an InterventionPlan. The full intervention
 * paradigm is returned — every option marked selected or ruled-out with
 * its reasoning — so the caller (and a demo, and an auditor) can see WHY
 * a course was, or was not, the answer.
 */
export function recommendInterventions(input: RecommendInput): InterventionPlan {
  const { diagnosis, situation } = input;
  const author: Performer = input.author ?? { id: 'urn:foxxi:agent:performance-consultant', kind: 'agent', role: 'performance consultant' };
  const direction = directionOf(author.kind, situation.performer.kind);

  const select = new Set<InterventionType>();
  const rationale = new Map<InterventionType, string>();
  const ruledOut = new Map<InterventionType, string>();

  // ── Emergent regime — probes + coaching, never instruction. ──
  if (diagnosis.method === 'dispositional-read') {
    select.add('probe');
    rationale.set('probe', 'The Emergent regime calls for safe-to-fail constraint probes — change a constraint, observe, steer. Compose agent-disposition.buildProbe; amplify what coheres.');
    select.add('coaching');
    rationale.set('coaching', 'A feedback loop steers an Emergent system by vector. Coaching reads the disposition with the performer rather than prescribing a target.');
    ruledOut.set('instruction', 'You cannot instruct your way through the Emergent regime — instruction presumes a knowable exemplary state, which a complex, adaptive system does not have.');
    ruledOut.set('assessment', 'A score-vs-exemplary assessment imports the gap frame the Emergent regime rejects.');
    for (const t of ALL_INTERVENTIONS) {
      if (!select.has(t) && !ruledOut.has(t) && t !== 'no-intervention') {
        ruledOut.set(t, 'not the primary lever for an Emergent-regime disposition — probes and coaching come first.');
      }
    }
  } else if (diagnosis.method === 'stabilise-first') {
    select.add('environmental-fix');
    rationale.set('environmental-fix', 'Turbulent work must be stabilised by a decisive act before any intervention can be designed.');
    for (const t of ALL_INTERVENTIONS) {
      if (!select.has(t) && t !== 'no-intervention') {
        ruledOut.set(t, 'premature — the situation is not yet patterned enough to design this intervention against.');
      }
    }
  } else if (diagnosis.method === 'apply-practice') {
    // ── Evident regime — apply the established practice. ──
    select.add('reference');
    rationale.set('reference', 'The Evident regime applies a known, established response. Make that response available where the work happens — a reference / SOP, looked up, not taught. No cause analysis, no course.');
    for (const t of ALL_INTERVENTIONS) {
      if (!select.has(t) && t !== 'no-intervention') {
        ruledOut.set(t, 'not indicated — the Evident regime applies an established practice; it does not analyse a cause or close a gap.');
      }
    }
  } else {
    // ── Knowable regime — gap-analysis selection. ──
    const factors = diagnosis.factors!;
    const envDeficient = [factors.information, factors.instrumentation, factors.incentives].filter(c => !c.adequate);

    // 0. An unverified situation is verified before anything is built.
    if (situation.modalStatus === 'Hypothetical') {
      select.add('assessment');
      rationale.set('assessment', 'The situation is still Hypothetical — measure it before investing in any intervention. An assessment promotes the claim to Asserted (or dismisses it).');
    }

    // 1. Environmental deficiencies dominate — fix the workplace.
    if (factors.instrumentation.adequate === false || factors.incentives.adequate === false) {
      select.add('environmental-fix');
      rationale.set('environmental-fix', `Environmental deficiency in ${[!factors.instrumentation.adequate ? 'tools/process' : '', !factors.incentives.adequate ? 'incentives/consequences' : ''].filter(Boolean).join(' + ')}. The workplace is the lever — a course cannot fix a broken tool or a misaligned incentive.`);
    }
    if (factors.information.adequate === false) {
      select.add('performance-support');
      rationale.set('performance-support', 'The Information factor is deficient — expectations or guidance are not available at the moment of performance. A job aid delivers the information in the flow of work; it does not require it to be carried in memory.');
    }

    // 2. Genuine skill deficiency — but instruction vs. job aid vs.
    //    practice depends on frequency and on whether the skill exists.
    if (diagnosis.skillDeficiency) {
      if (situation.frequency === 'rare' || situation.frequency === 'occasional') {
        select.add('performance-support');
        rationale.set('performance-support', `The task occurs ${situation.frequency}ly — there is no need to carry the procedure in memory. A job aid delivered at the point of work is cheaper and more reliable than a course.`);
        ruledOut.set('instruction', `The skill is genuinely absent, but for ${situation.frequency} work a job aid out-performs a course — instruction is reserved for skills needed fluently and from memory.`);
      } else {
        select.add('instruction');
        rationale.set('instruction', `A genuine knowledge/skill deficiency in a ${situation.frequency} task — the competency must be held fluently and from memory. Instruction (an emergent curriculum → course → module → lesson) is warranted.`);
        if (diagnosis.performedWellBefore) {
          select.add('practice');
          rationale.set('practice', 'The performer has done this well before — fluency has decayed rather than the skill being absent. Pair instruction with deliberate practice to restore it.');
        }
      }
    } else if (!envDeficient.length && diagnosis.rootCauses[0]?.startsWith('no deficiency')) {
      select.add('no-intervention');
      rationale.set('no-intervention', 'No deficiency was isolated. The gap may be acceptable variance or the exemplary state mis-stated. Building content here would be waste.');
    }

    // 3. Motivation — coaching, not content.
    if (factors.motives.adequate === false) {
      select.add('coaching');
      rationale.set('coaching', 'The Motives factor is deficient — the performer can perform but is not choosing to. A course cannot install motivation; a coaching feedback loop addresses it.');
      ruledOut.set('instruction', (ruledOut.get('instruction') ?? '') + ' A motivation gap is not closed by teaching what is already known.');
    }

    // 4. Capacity — an environmental/selection matter, not content.
    if (factors.capacity.adequate === false) {
      select.add('environmental-fix');
      rationale.set('environmental-fix', (rationale.get('environmental-fix') ? rationale.get('environmental-fix') + ' ' : '') + 'The Capacity factor is deficient — the fit between performer and task is wrong. This is a selection / job-design matter, not a content matter.');
    }

    // Default ruled-out reasons for anything still unselected.
    for (const t of ALL_INTERVENTIONS) {
      if (select.has(t) || ruledOut.has(t) || t === 'no-intervention') continue;
      if (t === 'instruction') ruledOut.set(t, 'No genuine skill deficiency in a frequent task was found — instruction is not warranted.');
      else if (t === 'reference') ruledOut.set(t, 'The analysis did not isolate a look-it-up knowledge need.');
      else if (t === 'probe') ruledOut.set(t, 'Probes are an Emergent-regime tool; this work is Knowable, where a cause can be analysed directly.');
      else ruledOut.set(t, 'Not indicated by the analysis.');
    }
  }

  // Assemble the full paradigm.
  const paradigm: InterventionOption[] = ALL_INTERVENTIONS.map(type => {
    const selected = select.has(type);
    const opt: InterventionOption = {
      type,
      selected,
      rationale: selected ? (rationale.get(type) ?? 'selected by the analysis.') : (ruledOut.get(type) ?? 'not selected.'),
      ...(!selected && ruledOut.has(type) ? { ruledOutBecause: ruledOut.get(type)! } : {}),
    };
    const authoring = selected ? authoringFor(type, direction) : undefined;
    if (authoring) opt.authoring = authoring;
    return opt;
  });
  const selected = paradigm.filter(o => o.selected);
  const contentWarranted = selected.some(o => !!o.authoring);

  const headline = selected.length === 0
    ? 'no intervention selected'
    : selected.map(o => o.type).join(' + ');
  const dirNote = describeDirection(direction);
  const summary = contentWarranted
    ? `Content IS warranted for this situation — ${headline}. ${dirNote.charAt(0).toUpperCase()}${dirNote.slice(1)}`
    : `Content is NOT the answer for this situation — ${headline}. ${diagnosis.method === 'dispositional-read'
        ? 'The Emergent regime calls for probes, not courses.'
        : diagnosis.method === 'stabilise-first'
          ? 'Turbulent work must be stabilised before anything can be designed.'
          : 'The analysis isolated an environmental / motivational / capacity cause that no course can fix — the common finding that most performance situations are environmental.'}`;

  return {
    situationId: situation.id,
    diagnosis,
    paradigm,
    selected,
    contentWarranted,
    direction,
    summary,
  };
}

// ── Evaluation — closing a Knowable gap (four-level → cg:supersedes) ─

/**
 * A four-level evaluation of an intervention. This is the Knowable
 * regime's closing move: an exemplary state was established, an
 * intervention was applied, and the loop closes when the observed state
 * is re-measured against the exemplary one. It is expressed as a
 * modal-status progression:
 *   response   — a recorded reaction (Hypothetical evidence of value).
 *   capability — an assessment result (Asserted competency, or not).
 *   transfer   — evidence the behaviour transferred to real work (an LRS
 *                statement / a trajectory step in the work context).
 *   outcome    — the situation's observed-state, re-measured against the
 *                exemplary one. If the gap closed, the intervention
 *                worked; the new state supersedes the old (`cg:supersedes`).
 */
export interface EvaluateInput {
  plan: InterventionPlan;
  situation: PerformanceSituation;
  response?: { favourable: boolean; note: string };
  capability?: { assessed: boolean; passed: boolean; note: string };
  transfer?: { transferred: boolean; evidence: string };
  /** The re-measured observed performance after the intervention. */
  newObserved?: string;
}

export interface InterventionEvaluation {
  situationId: string;
  interventions: InterventionType[];
  levels: {
    response?: { favourable: boolean; note: string };
    capability?: { assessed: boolean; passed: boolean; note: string };
    transfer?: { transferred: boolean; evidence: string };
    outcome?: { gapClosed: boolean; before: string; after: string };
  };
  verdict: 'closed' | 'improved' | 'no-change' | 'worsened' | 'too-early';
  /** The descriptor state this evaluation supersedes — the old observed-state. */
  supersedes: string;
  /** What performance management should do next with this result. */
  nextAction: string;
}

export function evaluateIntervention(input: EvaluateInput): InterventionEvaluation {
  const { plan, situation } = input;
  const exemplary = plan.diagnosis.exemplary;
  const levels: InterventionEvaluation['levels'] = {};
  if (input.response) levels.response = input.response;
  if (input.capability) levels.capability = input.capability;
  if (input.transfer) levels.transfer = input.transfer;

  let verdict: InterventionEvaluation['verdict'] = 'too-early';
  let nextAction = 'Continue tracking — transfer (to real work) and outcome (situation re-measured) evidence is not yet in.';

  if (input.newObserved !== undefined) {
    const gapClosed = (exemplary !== undefined
        && input.newObserved.trim().toLowerCase() === exemplary.trim().toLowerCase())
      || (input.transfer?.transferred === true && input.capability?.passed === true);
    levels.outcome = { gapClosed, before: situation.observed, after: input.newObserved };
    if (gapClosed) {
      verdict = 'closed';
      nextAction = `The gap is closed. Emit a cg:supersedes-linked PerformanceSituation descriptor whose observed-state is "${input.newObserved}" and modalStatus Asserted; retire the intervention.`;
    } else if (input.newObserved !== situation.observed) {
      verdict = 'improved';
      nextAction = 'Performance improved but the gap is not fully closed. Re-contextualize against the new observed-state — the remaining gap may now have a different root cause.';
    } else {
      verdict = 'no-change';
      nextAction = 'No change in observed performance despite the intervention. This is a transfer failure — re-contextualize; the original cause analysis likely mis-identified the root cause (often: the real cause was environmental).';
    }
  } else if (input.transfer?.transferred === false) {
    verdict = 'no-change';
    nextAction = 'Capability may have been demonstrated but the behaviour did not transfer to real work — a classic transfer failure. Add performance-support / coaching at the point of work, or re-contextualize.';
  }

  return {
    situationId: situation.id,
    interventions: plan.selected.map(o => o.type),
    levels,
    verdict,
    supersedes: situation.observed,
    nextAction,
  };
}

// ── Performance portfolio (the performance-management read) ─────────

export interface PortfolioEntry {
  situation: PerformanceSituation;
  plan: InterventionPlan;
  evaluation?: InterventionEvaluation;
}

export interface PerformancePortfolio {
  entries: number;
  /** How the intervention paradigm actually distributed — the headline
   *  evidence that the system is performance-driven, not content-driven. */
  interventionMix: Record<string, number>;
  contentVsNonContent: { content: number; nonContent: number };
  closed: number;
  improved: number;
  openSituations: number;
  /** The single most useful management read. */
  readout: string;
}

/**
 * Roll a set of contextualized situations into a portfolio read — the
 * performance-management view. The key number is contentVsNonContent: a
 * system that is genuinely performance-driven will route a large share
 * of situations to NON-content interventions.
 */
export function rollUpPortfolio(entries: readonly PortfolioEntry[]): PerformancePortfolio {
  const interventionMix: Record<string, number> = {};
  let content = 0;
  let nonContent = 0;
  let closed = 0;
  let improved = 0;
  for (const e of entries) {
    for (const o of e.plan.selected) interventionMix[o.type] = (interventionMix[o.type] ?? 0) + 1;
    if (e.plan.contentWarranted) content++; else nonContent++;
    if (e.evaluation?.verdict === 'closed') closed++;
    if (e.evaluation?.verdict === 'improved') improved++;
  }
  const openSituations = entries.length - closed;
  const total = entries.length || 1;
  const nonContentPct = Math.round((nonContent / total) * 100);
  return {
    entries: entries.length,
    interventionMix,
    contentVsNonContent: { content, nonContent },
    closed,
    improved,
    openSituations,
    readout: `${entries.length} contextualized situation(s): ${nonContentPct}% routed to non-content interventions (environmental fixes, coaching, probes) — evidence the system is performance-driven, not content-driven.`,
  };
}
