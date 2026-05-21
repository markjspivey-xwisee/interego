/**
 * Foxxi Performance Architecture — the diagnosis → intervention spine.
 *
 * Traditional learning systems start with content ("here is a course").
 * This module starts with PERFORMANCE: a typed description of what a
 * performer (human OR agent) is trying to accomplish, the gap between
 * desired and observed, and the work context it sits in. Content is
 * never assumed — it is one possible intervention, selected (or ruled
 * out) by a diagnosis.
 *
 * The novel first principle is that **performance consulting is
 * Cynefin-routed**. Classic Human Performance Technology — Gilbert's
 * Behavior Engineering Model, Mager & Pipe's "could they do it if their
 * life depended on it" — is a Complicated-domain method: an expert
 * closes a knowable gap. It does NOT apply to a Complex adaptive system
 * (e.g. a team of agents). So this module reads the domain FIRST, then
 * picks the consulting method:
 *
 *   · Clear / Complicated → HPT gap analysis (Gilbert BEM + Mager-Pipe).
 *     A knowable gap; an intervention can be analysed and selected.
 *   · Complex            → a dispositional read (composes
 *     `agent-disposition.ts`): no gap, no ideal state — probes, vectors,
 *     constraints. You cannot instruct your way through the Complex
 *     domain.
 *   · Chaotic            → stabilise first, then re-read.
 *
 * The output is an InterventionPlan — the full *paradigm* of possible
 * interventions (instruction, performance-support, assessment,
 * coaching, probe, environmental-fix, …), each marked selected or
 * ruled-out with its reasoning. Crucially the plan can conclude that no
 * content should be built at all — Gilbert's finding that most
 * performance gaps are environmental, not individual.
 *
 * Emergent from Interego: a PerformanceGap is a typed context
 * descriptor with a modal status; diagnosis is a composition over the
 * performer's disposition / record / work environment; the intervention
 * decision is a paradigmatic operation (the intervention space is a
 * paradigm set, the diagnosis supplies the constraints, the selected
 * intervention is the surviving cell). The evaluation loop closes with
 * `cg:supersedes` — a measured new performance state supersedes the old.
 *
 * Layer: L3 vertical. Composes the substrate; no L1/L2/L3 ontology
 * change. Domain terms are `foxxi:`-namespaced (see foxxi-vocab.ts).
 */

import { assessDisposition, type CynefinDomain } from './agent-disposition.js';
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

// ── The performance gap ─────────────────────────────────────────────

export type GapModalStatus = 'Hypothetical' | 'Asserted';

export interface PerformanceGap {
  id: string;
  performer: Performer;
  /** What the performer is trying to accomplish — the work context. */
  workContext: string;
  /** The competency / behaviour in question. */
  competency: string;
  /** Desired performance, stated plainly. */
  desired: string;
  /** Observed performance. */
  observed: string;
  /** How often the task occurs — drives instruction-vs-job-aid. */
  frequency: 'continuous' | 'frequent' | 'occasional' | 'rare';
  /** Consequence of poor performance. */
  criticality: 'low' | 'moderate' | 'high' | 'safety-critical';
  /**
   * Modal status of the gap CLAIM itself. A reported gap is Hypothetical
   * until measured; an assessment promotes it to Asserted.
   */
  modalStatus: GapModalStatus;
  /** Where the gap signal came from (an LRS statement, a trajectory, a
   *  manager observation, a self-report). */
  provenance: string;
  /** The Cynefin domain of the WORK, if the caller already knows it. */
  domain?: CynefinDomain;
}

// ── Gilbert's Behavior Engineering Model (the Complicated-domain tool) ─

/** One of Gilbert's six cells. */
export interface CellReading {
  cell: string;
  /** Environmental cells are the workplace's responsibility; individual
   *  cells are the performer's repertory. */
  category: 'environmental' | 'individual';
  adequate: boolean;
  evidence: string;
  /** If this cell is the deficiency, the intervention class it implies. */
  impliesIntervention: InterventionType;
}

export interface BehaviorEngineeringModel {
  /** Environmental — Gilbert found these account for the majority of gaps. */
  information: CellReading;
  instrumentation: CellReading;
  incentives: CellReading;
  /** Individual. */
  knowledgeSkill: CellReading;
  capacity: CellReading;
  motives: CellReading;
}

type BemCellKey = keyof BehaviorEngineeringModel;

const BEM_TEMPLATE: Record<BemCellKey, { category: CellReading['category']; cell: string; implies: InterventionType }> = {
  information: { category: 'environmental', cell: 'Information — expectations, guidance, feedback', implies: 'performance-support' },
  instrumentation: { category: 'environmental', cell: 'Instrumentation — tools, resources, processes', implies: 'environmental-fix' },
  incentives: { category: 'environmental', cell: 'Incentives — consequences, rewards, alignment', implies: 'environmental-fix' },
  knowledgeSkill: { category: 'individual', cell: 'Knowledge & Skill — what the performer knows / can do', implies: 'instruction' },
  capacity: { category: 'individual', cell: 'Capacity — fit between performer and task demands', implies: 'environmental-fix' },
  motives: { category: 'individual', cell: 'Motives — does the performer want to perform', implies: 'coaching' },
};

// ── The intervention paradigm ───────────────────────────────────────

/**
 * The paradigm set of interventions. Instruction is one cell among
 * many; a healthy diagnosis frequently selects something other than
 * "build a course".
 */
export type InterventionType =
  | 'instruction'          // curriculum/course/module/lesson — a real skill gap, needed from memory
  | 'performance-support'  // job aid / EPSS — delivered in the flow of work
  | 'reference'            // searchable knowledge — looked up, not "trained"
  | 'practice'             // deliberate practice / simulation — the skill exists, needs fluency
  | 'assessment'           // verify or certify — measure, do not teach
  | 'coaching'             // a feedback loop — transfer, motivation, the Complex domain
  | 'probe'                // a safe-to-fail constraint probe — the Complex domain
  | 'environmental-fix'    // tools / information / incentives — not a content deliverable
  | 'no-intervention';     // the gap is acceptable or self-resolving

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

// ── Diagnosis ───────────────────────────────────────────────────────

export type PerformanceMethod = 'hpt-gap-analysis' | 'dispositional-read' | 'stabilise-then-read';

export interface Diagnosis {
  gapId: string;
  domain: CynefinDomain;
  method: PerformanceMethod;
  /** For the HPT method — the six-cell reading. Absent for Complex. */
  bem?: BehaviorEngineeringModel;
  /** The dominant deficiency cell(s) by name. */
  rootCauses: string[];
  /**
   * Mager & Pipe's discriminating question: would the performer do it
   * correctly if their life depended on it? If yes, it is NOT a skill
   * deficiency — and instruction is the wrong intervention.
   */
  skillDeficiency: boolean;
  /** Whether the performer has performed this competency well before —
   *  decay of fluency rather than absence of the skill. */
  performedWellBefore?: boolean;
  /** For the dispositional method — the disposition read instead of a gap. */
  disposition?: { domain: CynefinDomain; vector: string; stance: string; method: string };
  reasoning: string[];
  /** An honest note when classic HPT is the wrong frame for this gap. */
  caveat?: string;
}

export interface DiagnoseInput {
  gap: PerformanceGap;
  /** Evidence about the six BEM cells — for Clear/Complicated gaps.
   *  Any cell not supplied is assumed adequate. */
  bemEvidence?: Partial<Record<BemCellKey, { adequate: boolean; evidence: string }>>;
  /** Agent trajectories — for Complex gaps, the dispositional read
   *  composes `agent-disposition.ts` off these. */
  trajectories?: readonly AgentTrajectory[];
  /** Mager-Pipe — could the performer do it if their life depended on it? */
  couldDoIfLifeDependedOnIt?: boolean;
  /** Has the performer ever performed this competency well before? */
  performedWellBefore?: boolean;
}

/** Decide which consulting method the work's Cynefin domain calls for. */
function methodForDomain(domain: CynefinDomain): PerformanceMethod {
  if (domain === 'Complex') return 'dispositional-read';
  if (domain === 'Chaotic') return 'stabilise-then-read';
  return 'hpt-gap-analysis';
}

/** Build the six-cell BEM from supplied evidence (unsupplied = adequate). */
function buildBem(evidence: DiagnoseInput['bemEvidence']): BehaviorEngineeringModel {
  const cell = (key: BemCellKey): CellReading => {
    const t = BEM_TEMPLATE[key];
    const e = evidence?.[key];
    return {
      cell: t.cell,
      category: t.category,
      adequate: e?.adequate ?? true,
      evidence: e?.evidence ?? 'no deficiency evidence supplied — assumed adequate.',
      impliesIntervention: t.implies,
    };
  };
  return {
    information: cell('information'),
    instrumentation: cell('instrumentation'),
    incentives: cell('incentives'),
    knowledgeSkill: cell('knowledgeSkill'),
    capacity: cell('capacity'),
    motives: cell('motives'),
  };
}

/**
 * Diagnose a performance gap. Routes on the Cynefin domain of the work:
 * HPT gap analysis for Clear/Complicated, a dispositional read for
 * Complex, stabilisation for Chaotic.
 */
export function diagnose(input: DiagnoseInput): Diagnosis {
  const { gap } = input;

  // Determine the domain. Honour an explicit domain; else, for an agent
  // with trajectories, read it off the disposition; else default to
  // Complicated (most structured workplace tasks live there).
  let domain: CynefinDomain;
  if (gap.domain) {
    domain = gap.domain;
  } else if (gap.performer.kind === 'agent' && input.trajectories && input.trajectories.length > 0) {
    domain = assessDisposition(input.trajectories).cynefin.domain;
  } else {
    domain = 'Complicated';
  }
  const method = methodForDomain(domain);
  const reasoning: string[] = [];

  // ── Complex domain — refuse the gap frame, read disposition. ──
  if (method === 'dispositional-read') {
    const traj = input.trajectories ?? [];
    const disp = traj.length > 0 ? assessDisposition(traj) : null;
    reasoning.push('The work sits in the Complex domain — a complex adaptive system has dispositions and propensities, not a fixable gap. Classic HPT gap analysis (actual vs. exemplary) does not apply.');
    reasoning.push('Composing agent-disposition.ts: read the disposition and the vector of change, not a score against an ideal.');
    return {
      gapId: gap.id,
      domain,
      method,
      rootCauses: ['not applicable — the Complex domain has no single fixable root cause'],
      skillDeficiency: false,
      ...(disp ? {
        disposition: {
          domain: disp.cynefin.domain,
          vector: `${disp.vector.direction} — ${disp.vector.basis}`,
          stance: disp.cynefin.stance,
          method: disp.method,
        },
      } : {}),
      reasoning,
      caveat: 'This gap was framed as actual-vs-desired, but the work is Complex. Do NOT build instruction toward an ideal state. Run safe-to-fail probes (agent-disposition.buildProbe), sense which cohere, and steer by vector.',
    };
  }

  // ── Chaotic domain — stabilise first. ──
  if (method === 'stabilise-then-read') {
    reasoning.push('The work sits in the Chaotic domain — behaviour is not yet patterned. No intervention can be analysed until the situation is stabilised.');
    return {
      gapId: gap.id,
      domain,
      method,
      rootCauses: ['instability — there is no patterned behaviour to diagnose'],
      skillDeficiency: false,
      reasoning,
      caveat: 'Act first to stabilise (act ▸ sense ▸ respond), THEN re-diagnose. Authoring instruction now would be instruction toward a target that does not yet exist.',
    };
  }

  // ── Clear / Complicated — HPT gap analysis (Gilbert + Mager-Pipe). ──
  const bem = buildBem(input.bemEvidence);
  reasoning.push(`The work sits in the ${domain} domain — a knowable gap; HPT gap analysis (Gilbert BEM + Mager-Pipe) applies.`);

  // Gilbert: examine the environmental cells first — they account for
  // most performance gaps and are cheaper to fix than re-skilling people.
  const deficientCells = (Object.keys(bem) as BemCellKey[])
    .map(k => bem[k])
    .filter(c => !c.adequate);
  const envDeficient = deficientCells.filter(c => c.category === 'environmental');
  const indDeficient = deficientCells.filter(c => c.category === 'individual');

  // Mager & Pipe: is this genuinely a skill/knowledge deficiency?
  // If they could do it if their life depended on it → it is NOT.
  let skillDeficiency: boolean;
  if (input.couldDoIfLifeDependedOnIt === true) {
    skillDeficiency = false;
    reasoning.push('Mager-Pipe: the performer COULD do it if their life depended on it — therefore it is not a skill deficiency. Instruction will not help; look to incentives, tools, or expectations.');
  } else if (input.couldDoIfLifeDependedOnIt === false) {
    skillDeficiency = true;
    reasoning.push('Mager-Pipe: the performer could NOT do it even if their life depended on it — a genuine skill/knowledge deficiency.');
  } else {
    skillDeficiency = bem.knowledgeSkill.adequate === false;
    reasoning.push(`Mager-Pipe question not answered directly; inferring from the Knowledge & Skill cell (${skillDeficiency ? 'deficient' : 'adequate'}).`);
  }

  const rootCauses: string[] = [];
  if (envDeficient.length > 0) {
    reasoning.push(`Environmental deficiencies found (${envDeficient.length}) — Gilbert: the workplace, not the performer, is the dominant lever. Fix these before considering instruction.`);
    rootCauses.push(...envDeficient.map(c => c.cell));
  }
  if (skillDeficiency) rootCauses.push(bem.knowledgeSkill.cell);
  if (indDeficient.some(c => c.cell.startsWith('Motives'))) rootCauses.push(bem.motives.cell);
  if (indDeficient.some(c => c.cell.startsWith('Capacity'))) rootCauses.push(bem.capacity.cell);
  if (rootCauses.length === 0) {
    rootCauses.push('no deficiency isolated — the gap may be acceptable variance, or the desired state may be mis-stated.');
  }

  const caveat = (!skillDeficiency && envDeficient.length === 0 && indDeficient.length === 0)
    ? 'No deficiency was isolated. Before building anything, re-check that the gap is real (assessment) and that the desired performance is correctly stated.'
    : undefined;

  return {
    gapId: gap.id,
    domain,
    method,
    bem,
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
  gapId: string;
  diagnosis: Diagnosis;
  /** The full paradigm — every option, selected or not, with reasoning. */
  paradigm: InterventionOption[];
  /** The selected intervention(s), in priority order. */
  selected: InterventionOption[];
  /** The headline answer to "does this gap need content built?" */
  contentWarranted: boolean;
  /** The directionality any authored content would be produced in. */
  direction: PerformanceDirection;
  summary: string;
}

export interface RecommendInput {
  diagnosis: Diagnosis;
  gap: PerformanceGap;
  /** Who would author the intervention — defaults to an agent (the
   *  diagnosing agent itself authoring for the performer). */
  author?: Performer;
}

/**
 * Turn a diagnosis into an InterventionPlan. The full intervention
 * paradigm is returned — every option marked selected or ruled-out with
 * its reasoning — so the caller (and a demo, and an auditor) can see WHY
 * a course was, or was not, the answer.
 */
export function recommendInterventions(input: RecommendInput): InterventionPlan {
  const { diagnosis, gap } = input;
  const author: Performer = input.author ?? { id: 'urn:foxxi:agent:performance-consultant', kind: 'agent', role: 'performance consultant' };
  const direction = directionOf(author.kind, gap.performer.kind);

  const select = new Set<InterventionType>();
  const rationale = new Map<InterventionType, string>();
  const ruledOut = new Map<InterventionType, string>();

  // ── Complex domain — probes + coaching, never instruction. ──
  if (diagnosis.method === 'dispositional-read') {
    select.add('probe');
    rationale.set('probe', 'The Complex domain calls for safe-to-fail constraint probes (probe ▸ sense ▸ respond). Compose agent-disposition.buildProbe; amplify what coheres.');
    select.add('coaching');
    rationale.set('coaching', 'A feedback loop steers a Complex system by vector. Coaching reads the disposition with the performer rather than prescribing a target.');
    ruledOut.set('instruction', 'You cannot instruct your way through the Complex domain — instruction presumes a knowable ideal state, which a complex adaptive system does not have.');
    ruledOut.set('assessment', 'A score-vs-exemplary assessment imports the gap frame the Complex domain rejects.');
    for (const t of ALL_INTERVENTIONS) {
      if (!select.has(t) && !ruledOut.has(t) && t !== 'no-intervention') {
        ruledOut.set(t, 'not the primary lever for a Complex-domain disposition — probes and coaching come first.');
      }
    }
  } else if (diagnosis.method === 'stabilise-then-read') {
    select.add('environmental-fix');
    rationale.set('environmental-fix', 'Chaotic work must be stabilised by a decisive act before any content intervention can be designed.');
    for (const t of ALL_INTERVENTIONS) {
      if (!select.has(t) && t !== 'no-intervention') {
        ruledOut.set(t, 'premature — the situation is not yet patterned enough to design this intervention against.');
      }
    }
  } else {
    // ── Clear / Complicated — HPT selection. ──
    const bem = diagnosis.bem!;
    const envDeficient = [bem.information, bem.instrumentation, bem.incentives].filter(c => !c.adequate);

    // 0. An unverified gap is verified before anything is built.
    if (gap.modalStatus === 'Hypothetical') {
      select.add('assessment');
      rationale.set('assessment', 'The gap is still Hypothetical — measure it before investing in any intervention. An assessment promotes the gap claim to Asserted (or dismisses it).');
    }

    // 1. Environmental deficiencies dominate — Gilbert. Fix the workplace.
    if (bem.instrumentation.adequate === false || bem.incentives.adequate === false) {
      select.add('environmental-fix');
      rationale.set('environmental-fix', `Environmental deficiency in ${[!bem.instrumentation.adequate ? 'tools/process' : '', !bem.incentives.adequate ? 'incentives/consequences' : ''].filter(Boolean).join(' + ')}. Gilbert: the workplace is the lever — a course cannot fix a broken tool or a misaligned incentive.`);
    }
    if (bem.information.adequate === false) {
      select.add('performance-support');
      rationale.set('performance-support', 'The Information cell is deficient — expectations or guidance are not available at the moment of performance. A job aid delivers the information in the flow of work; it does not require it to be carried in memory.');
    }

    // 2. Genuine skill deficiency — but instruction vs. job aid vs.
    //    practice depends on frequency and on whether the skill exists.
    if (diagnosis.skillDeficiency) {
      if (input.gap.frequency === 'rare' || input.gap.frequency === 'occasional') {
        select.add('performance-support');
        rationale.set('performance-support', `The task occurs ${input.gap.frequency}ly — there is no need to carry the procedure in memory. A job aid delivered at the point of work is cheaper and more reliable than a course.`);
        ruledOut.set('instruction', `The skill is genuinely absent, but for ${input.gap.frequency} work a job aid out-performs a course — instruction is reserved for skills needed fluently and from memory.`);
      } else {
        select.add('instruction');
        rationale.set('instruction', `A genuine knowledge/skill deficiency in a ${input.gap.frequency} task — the competency must be held fluently and from memory. Instruction (an emergent curriculum → course → module → lesson) is warranted.`);
        if (diagnosis.performedWellBefore) {
          select.add('practice');
          rationale.set('practice', 'The performer has done this well before — fluency has decayed rather than the skill being absent. Pair instruction with deliberate practice to restore it.');
        }
      }
    } else if (!envDeficient.length && diagnosis.rootCauses[0]?.startsWith('no deficiency')) {
      select.add('no-intervention');
      rationale.set('no-intervention', 'No deficiency was isolated. The gap may be acceptable variance or the desired state mis-stated. Building content here would be waste.');
    }

    // 3. Motivation — coaching, not content.
    if (bem.motives.adequate === false) {
      select.add('coaching');
      rationale.set('coaching', 'The Motives cell is deficient — the performer can perform but is not choosing to. A course cannot install motivation; a coaching feedback loop addresses it.');
      ruledOut.set('instruction', (ruledOut.get('instruction') ?? '') + ' A motivation gap is not closed by teaching what is already known.');
    }

    // 4. Capacity — an environmental/selection matter, not content.
    if (bem.capacity.adequate === false) {
      select.add('environmental-fix');
      rationale.set('environmental-fix', (rationale.get('environmental-fix') ? rationale.get('environmental-fix') + ' ' : '') + 'The Capacity cell is deficient — the fit between performer and task is wrong. This is a selection / job-design matter, not a content matter.');
    }

    // Default ruled-out reasons for anything still unselected.
    for (const t of ALL_INTERVENTIONS) {
      if (select.has(t) || ruledOut.has(t) || t === 'no-intervention') continue;
      if (t === 'instruction') ruledOut.set(t, 'No genuine skill deficiency in a frequent task was found — instruction is not warranted.');
      else if (t === 'reference') ruledOut.set(t, 'The diagnosis did not isolate a look-it-up knowledge need.');
      else if (t === 'probe') ruledOut.set(t, 'Probes are a Complex-domain tool; this work is Clear/Complicated, where a gap can be analysed directly.');
      else ruledOut.set(t, 'Not indicated by the diagnosis.');
    }
  }

  // Assemble the full paradigm.
  const paradigm: InterventionOption[] = ALL_INTERVENTIONS.map(type => {
    const selected = select.has(type);
    const opt: InterventionOption = {
      type,
      selected,
      rationale: selected ? (rationale.get(type) ?? 'selected by the diagnosis.') : (ruledOut.get(type) ?? 'not selected.'),
      ...(selected && ruledOut.has(type) ? {} : {}),
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
  const summary = contentWarranted
    ? `Content IS warranted for this gap: ${headline}. Authored ${describeDirection(direction)}`
    : `Content is NOT the answer for this gap: ${headline}. ${diagnosis.method === 'dispositional-read'
        ? 'The Complex domain calls for probes, not courses.'
        : 'The diagnosis isolated an environmental / motivational / capacity cause that no course can fix — Gilbert\'s finding that most gaps are environmental.'}`;

  return {
    gapId: gap.id,
    diagnosis,
    paradigm,
    selected,
    contentWarranted,
    direction,
    summary,
  };
}

// ── Evaluation — closing the loop (Kirkpatrick → cg:supersedes) ──────

/**
 * Kirkpatrick's four levels expressed as a modal-status progression:
 *   L1 reaction  — a recorded response (Hypothetical evidence of value).
 *   L2 learning  — an assessment result (Asserted competency, or not).
 *   L3 behaviour — evidence the behaviour transferred to real work
 *                  (an LRS statement / a trajectory step in the work
 *                  context — this is where the loop touches the gap).
 *   L4 results   — the gap's observed-state, re-measured. If it closed,
 *                  the intervention worked; the new state supersedes the
 *                  old (`cg:supersedes`).
 */
export interface EvaluateInput {
  plan: InterventionPlan;
  gap: PerformanceGap;
  level1Reaction?: { favourable: boolean; note: string };
  level2Learning?: { assessed: boolean; passed: boolean; note: string };
  level3Behaviour?: { transferred: boolean; evidence: string };
  /** The re-measured observed performance after the intervention. */
  newObserved?: string;
}

export interface InterventionEvaluation {
  gapId: string;
  interventions: InterventionType[];
  levels: {
    level1?: { favourable: boolean; note: string };
    level2?: { assessed: boolean; passed: boolean; note: string };
    level3?: { transferred: boolean; evidence: string };
    level4?: { gapClosed: boolean; before: string; after: string };
  };
  verdict: 'closed' | 'improved' | 'no-change' | 'worsened' | 'too-early';
  /** The descriptor state this evaluation supersedes — the old gap.observed. */
  supersedes: string;
  /** What performance management should do next with this result. */
  nextAction: string;
}

export function evaluateIntervention(input: EvaluateInput): InterventionEvaluation {
  const { plan, gap } = input;
  const levels: InterventionEvaluation['levels'] = {};
  if (input.level1Reaction) levels.level1 = input.level1Reaction;
  if (input.level2Learning) levels.level2 = input.level2Learning;
  if (input.level3Behaviour) levels.level3 = input.level3Behaviour;

  let verdict: InterventionEvaluation['verdict'] = 'too-early';
  let nextAction = 'Continue tracking — Level 3 (transfer to real work) and Level 4 (gap re-measured) evidence is not yet in.';

  if (input.newObserved !== undefined) {
    const gapClosed = input.newObserved.trim().toLowerCase() === gap.desired.trim().toLowerCase()
      || (input.level3Behaviour?.transferred === true && input.level2Learning?.passed === true);
    levels.level4 = { gapClosed, before: gap.observed, after: input.newObserved };
    if (gapClosed) {
      verdict = 'closed';
      nextAction = `The gap is closed. Emit a cg:supersedes-linked PerformanceGap descriptor whose observed-state is "${input.newObserved}" and modalStatus Asserted; retire the intervention.`;
    } else if (input.newObserved !== gap.observed) {
      verdict = 'improved';
      nextAction = 'Performance improved but the gap is not fully closed. Re-diagnose against the new observed-state — the remaining gap may now have a different root cause.';
    } else {
      verdict = input.level2Learning?.passed === false ? 'no-change' : 'no-change';
      nextAction = 'No change in observed performance despite the intervention. This is a Level 3 transfer failure — re-diagnose; the original cause analysis likely mis-identified the root cause (often: the real cause was environmental).';
    }
  } else if (input.level3Behaviour?.transferred === false) {
    verdict = 'no-change';
    nextAction = 'Level 2 may have passed but the behaviour did not transfer to real work — a classic transfer failure. Add performance-support / coaching at the point of work, or re-diagnose.';
  }

  return {
    gapId: gap.id,
    interventions: plan.selected.map(o => o.type),
    levels,
    verdict,
    supersedes: gap.observed,
    nextAction,
  };
}

// ── Performance portfolio (the performance-management read) ─────────

export interface PortfolioEntry {
  gap: PerformanceGap;
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
  openGaps: number;
  /** The single most useful management read. */
  readout: string;
}

/**
 * Roll a set of diagnosed gaps into a portfolio read — the performance-
 * management view. The key number is contentVsNonContent: a system that
 * is genuinely performance-driven will route a large share of gaps to
 * NON-content interventions.
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
  const openGaps = entries.length - closed;
  const total = entries.length || 1;
  const nonContentPct = Math.round((nonContent / total) * 100);
  return {
    entries: entries.length,
    interventionMix,
    contentVsNonContent: { content, nonContent },
    closed,
    improved,
    openGaps,
    readout: `${entries.length} diagnosed gap(s): ${nonContentPct}% routed to non-content interventions (environmental fixes, coaching, probes) — evidence the system is performance-driven, not content-driven. ${closed} closed, ${improved} improved, ${openGaps} still open.`,
  };
}
