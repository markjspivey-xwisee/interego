/**
 * Foxxi Emergent Content — instruction & support as composition.
 *
 * Once a diagnosis (see performance-architecture.ts) concludes that
 * content IS warranted, this module is how the content comes to exist.
 * The first principle is that a course is NOT an authored artifact sitting
 * in a CMS. It is an emergent composition:
 *
 *   curriculum  = a syntagm of courses     (toward a set of competencies)
 *   course      = a syntagm of modules
 *   module      = a syntagm of lessons
 *   lesson      = a syntagm of grounding fragments  (PGSL-atom content)
 *
 * Every level is a syntagm — an ordered chain — and every POSITION in a
 * syntagm holds a paradigm: the set of interchangeable alternatives for
 * that competency-point (a concept told as text, as a worked example, as
 * a simulation; a beginner module vs. an advanced one). Authoring is the
 * act of composing fragments into syntagms. Personalisation is a
 * paradigmatic operation: the substrate's composition algebra collapses
 * each paradigm to one cell for a given performer (override) and drops
 * positions whose competency-point the performer has already mastered
 * (restriction). The same fragments re-compose into a different resolved
 * course for every performer — the course is a recipe, not a record.
 *
 * Authoring is exposed as affordances, so a human instructional designer
 * and an agent invoke the SAME authoring tools — `authorFragment`,
 * `authorLesson`, `composeCourse`, `composeCurriculum`. That symmetry is
 * what makes the four directionalities real: H2H, H2A, A2H, A2A differ
 * only in the Agent facet (who authored, who the audience is), never in
 * the tooling. An "agent playbook" is not a new type — it is a Course
 * with an agent audience, its fragments delivered as context descriptors
 * the consuming agent composes into its working context rather than as
 * slides.
 *
 * Layer: L3 vertical. Composes the substrate (PGSL atoms, the syntagm /
 * paradigm distinction, the composition algebra). No L1/L2/L3 ontology
 * change; domain terms are `foxxi:`-namespaced.
 */

import { createHash } from 'node:crypto';
import {
  type Performer, type PerformerKind, type PerformanceDirection,
  directionOf, describeDirection, type InterventionPlan,
} from '../../agentic-performance-practice/src/performance-architecture.js';

// ── Grounding fragments — the atomic content unit ───────────────────

export type FragmentModality =
  | 'concept'           // a told concept
  | 'worked-example'    // a demonstrated example
  | 'video'             // a recorded demonstration
  | 'simulation'        // an interactive practice environment
  | 'job-aid'           // an in-the-flow performance-support snippet
  | 'assessment-item'   // a question / task that measures
  | 'reference'         // a looked-up knowledge entry
  | 'practice-task'     // a deliberate-practice repetition
  | 'context-descriptor'; // doctrine/policy an agent ingests as context

/**
 * The cognitive level a fragment pitches at — how much prior grasp it
 * assumes. Fragments are ordered within a lesson from foundational
 * (assumes nothing) to advanced (assumes the rest), so the syntagm reads
 * as a coherent progression.
 */
export type CognitiveLevel = 'foundational' | 'working' | 'applied' | 'advanced';

const LEVEL_ORDER: Record<CognitiveLevel, number> = {
  foundational: 0, working: 1, applied: 2, advanced: 3,
};

export interface GroundingFragment {
  /** Content-addressed id — a PGSL atom (sha256 of the body + competency). */
  id: string;
  modality: FragmentModality;
  competencyPoint: string;
  /** The content body, or a dereferenceable pointer to it. */
  body: string;
  level: CognitiveLevel;
  /** Who authored it — the kind drives directionality. */
  authoredBy: Performer;
  provenance: string;
  /**
   * The performer disposition this fragment best suits — used to collapse
   * a paradigm during personalisation (e.g. 'prefers-worked-examples',
   * 'execution-biased', 'novice', 'expert').
   */
  suitsDisposition?: string;
}

export interface AuthorFragmentInput {
  modality: FragmentModality;
  competencyPoint: string;
  body: string;
  level: CognitiveLevel;
  authoredBy: Performer;
  provenance?: string;
  suitsDisposition?: string;
}

/** Mint a grounding fragment — content-addressed, like a PGSL atom. */
export function authorFragment(input: AuthorFragmentInput): GroundingFragment {
  const digest = createHash('sha256')
    .update(`${input.competencyPoint}\u0000${input.modality}\u0000${input.body}`)
    .digest('hex').slice(0, 24);
  return {
    id: `urn:foxxi:fragment:${digest}`,
    modality: input.modality,
    competencyPoint: input.competencyPoint,
    body: input.body,
    level: input.level,
    authoredBy: input.authoredBy,
    provenance: input.provenance ?? `authored by ${input.authoredBy.kind} ${input.authoredBy.id}`,
    ...(input.suitsDisposition ? { suitsDisposition: input.suitsDisposition } : {}),
  };
}

// ── Syntagm + paradigm ──────────────────────────────────────────────

/**
 * A position in a syntagm. `paradigm` holds the interchangeable
 * alternatives for this competency-point; a length-1 paradigm means
 * there is no choice. Personalisation collapses the paradigm to one cell.
 */
export interface SyntagmPosition<T> {
  competencyPoint: string;
  paradigm: T[];
}

function pos<T>(competencyPoint: string, paradigm: T[]): SyntagmPosition<T> {
  return { competencyPoint, paradigm };
}

// ── The content hierarchy — every level a syntagm ───────────────────

export interface Lesson {
  id: string;
  title: string;
  competency: string;
  audience: PerformerKind;
  authoredBy: Performer;
  /** A lesson is a syntagm of grounding fragments. */
  syntagm: SyntagmPosition<GroundingFragment>[];
}

export interface Module {
  id: string;
  title: string;
  competency: string;
  authoredBy: Performer;
  /** A module is a syntagm of lessons. */
  syntagm: SyntagmPosition<Lesson>[];
}

export interface Course {
  id: string;
  title: string;
  competency: string;
  audience: PerformerKind;
  authoredBy: Performer;
  /** A course is a syntagm of modules. */
  syntagm: SyntagmPosition<Module>[];
  /** moveOn criterion — composes with the cmi5 LMS layer (cmi5-lms.ts). */
  moveOn: 'Completed' | 'Passed' | 'CompletedOrPassed';
}

export interface Curriculum {
  id: string;
  title: string;
  targetCompetencies: string[];
  authoredBy: Performer;
  /** A curriculum is a syntagm of courses. */
  syntagm: SyntagmPosition<Course>[];
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}

// ── Authoring tools — the same affordances for humans and agents ────

export interface AuthorLessonInput {
  title: string;
  competency: string;
  audience: PerformerKind;
  authoredBy: Performer;
  /** Each position is one competency-point with one or more fragment
   *  alternatives (the paradigm at that position). */
  positions: Array<{ competencyPoint: string; fragments: GroundingFragment[] }>;
}

/**
 * Author a lesson — compose fragments into a syntagm. Fragments at each
 * position are kept in cognitive-level order (foundational → advanced) so the syntagm
 * reads as a coherent learning progression.
 */
export function authorLesson(input: AuthorLessonInput): Lesson {
  const syntagm = input.positions.map(p =>
    pos(p.competencyPoint, [...p.fragments].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])),
  );
  return {
    id: `urn:foxxi:lesson:${slug(input.competency)}:${slug(input.title)}`,
    title: input.title,
    competency: input.competency,
    audience: input.audience,
    authoredBy: input.authoredBy,
    syntagm,
  };
}

export interface AuthorModuleInput {
  title: string;
  competency: string;
  authoredBy: Performer;
  positions: Array<{ competencyPoint: string; lessons: Lesson[] }>;
}

/** Author a module — compose lessons into a syntagm. */
export function authorModule(input: AuthorModuleInput): Module {
  return {
    id: `urn:foxxi:module:${slug(input.competency)}:${slug(input.title)}`,
    title: input.title,
    competency: input.competency,
    authoredBy: input.authoredBy,
    syntagm: input.positions.map(p => pos(p.competencyPoint, p.lessons)),
  };
}

export interface ComposeCourseInput {
  title: string;
  competency: string;
  audience: PerformerKind;
  authoredBy: Performer;
  positions: Array<{ competencyPoint: string; modules: Module[] }>;
  moveOn?: Course['moveOn'];
}

/** Compose a course — a syntagm of modules toward one competency. */
export function composeCourse(input: ComposeCourseInput): Course {
  return {
    id: `urn:foxxi:course:${slug(input.competency)}:${slug(input.title)}`,
    title: input.title,
    competency: input.competency,
    audience: input.audience,
    authoredBy: input.authoredBy,
    syntagm: input.positions.map(p => pos(p.competencyPoint, p.modules)),
    moveOn: input.moveOn ?? 'CompletedOrPassed',
  };
}

export interface ComposeCurriculumInput {
  title: string;
  targetCompetencies: string[];
  authoredBy: Performer;
  positions: Array<{ competencyPoint: string; courses: Course[] }>;
}

/** Compose a curriculum — a syntagm of courses toward several competencies. */
export function composeCurriculum(input: ComposeCurriculumInput): Curriculum {
  return {
    id: `urn:foxxi:curriculum:${slug(input.title)}`,
    title: input.title,
    targetCompetencies: input.targetCompetencies,
    authoredBy: input.authoredBy,
    syntagm: input.positions.map(p => pos(p.competencyPoint, p.courses)),
  };
}

// ── Personalisation — the composition algebra made concrete ─────────

/** One resolved lesson in a personalised course. */
export interface ResolvedLesson {
  moduleTitle: string;
  lessonTitle: string;
  competencyPoint: string;
  fragments: GroundingFragment[];
}

export interface ResolvedCourse {
  courseId: string;
  title: string;
  competency: string;
  performer: Performer;
  /** The flattened, paradigm-collapsed, restriction-applied lesson chain. */
  lessons: ResolvedLesson[];
  /**
   * The composition trace — names each algebra operation applied
   * (restriction = dropped a mastered position; override = picked a
   * paradigm cell). The same Course re-composes differently per performer.
   */
  compositionTrace: string[];
}

export interface PersonaliseOptions {
  /** Competency-points the performer has already mastered — restriction
   *  drops these positions. */
  masteredCompetencyPoints?: readonly string[];
  /** A disposition tag — override picks the paradigm cell that suits it. */
  dispositionPreference?: string;
}

/**
 * Pick the paradigm cell of `cells` best suiting `pref` (an override
 * operation). `suitsOf` reads a cell's disposition-suitability — only
 * grounding fragments carry one; modules and lessons pass `() => undefined`.
 */
function pickCell<T>(cells: T[], pref: string | undefined, suitsOf: (t: T) => string | undefined): { picked: T; reason: string } {
  if (cells.length === 1) return { picked: cells[0]!, reason: 'single cell — no paradigm choice' };
  if (pref) {
    const match = cells.find(c => suitsOf(c) === pref);
    if (match) return { picked: match, reason: `override → cell suiting disposition "${pref}"` };
  }
  return { picked: cells[0]!, reason: 'override → default cell (no disposition match)' };
}

/**
 * Personalise a course for a performer. This IS the substrate's
 * composition algebra: `restriction` drops positions for already-mastered
 * competency-points; `override` collapses each remaining paradigm to the
 * cell that suits the performer's disposition. The Course itself is never
 * mutated — a different performer yields a different ResolvedCourse from
 * the identical fragments.
 */
export function personalize(course: Course, performer: Performer, opts: PersonaliseOptions = {}): ResolvedCourse {
  const mastered = new Set(opts.masteredCompetencyPoints ?? []);
  const trace: string[] = [];
  const lessons: ResolvedLesson[] = [];
  trace.push(`personalising course "${course.title}" for ${performer.kind} ${performer.id}`);

  for (const modulePos of course.syntagm) {
    if (mastered.has(modulePos.competencyPoint)) {
      trace.push(`restriction → dropped module position "${modulePos.competencyPoint}" (performer has mastered it)`);
      continue;
    }
    const modulePick = pickCell(modulePos.paradigm, opts.dispositionPreference, () => undefined);
    if (modulePos.paradigm.length > 1) {
      trace.push(`${modulePick.reason} at module position "${modulePos.competencyPoint}" → "${modulePick.picked.title}"`);
    }
    for (const lessonPos of modulePick.picked.syntagm) {
      if (mastered.has(lessonPos.competencyPoint)) {
        trace.push(`restriction → dropped lesson position "${lessonPos.competencyPoint}" (mastered)`);
        continue;
      }
      const lessonPick = pickCell(lessonPos.paradigm, opts.dispositionPreference, () => undefined);
      if (lessonPos.paradigm.length > 1) {
        trace.push(`${lessonPick.reason} at lesson position "${lessonPos.competencyPoint}" → "${lessonPick.picked.title}"`);
      }
      const fragments: GroundingFragment[] = [];
      for (const fragPos of lessonPick.picked.syntagm) {
        if (mastered.has(fragPos.competencyPoint)) {
          trace.push(`restriction → dropped fragment position "${fragPos.competencyPoint}" (mastered)`);
          continue;
        }
        const fragPick = pickCell(fragPos.paradigm, opts.dispositionPreference, f => f.suitsDisposition);
        if (fragPos.paradigm.length > 1) {
          trace.push(`${fragPick.reason} at fragment position "${fragPos.competencyPoint}" → ${fragPick.picked.modality}`);
        }
        fragments.push(fragPick.picked);
      }
      lessons.push({
        moduleTitle: modulePick.picked.title,
        lessonTitle: lessonPick.picked.title,
        competencyPoint: lessonPos.competencyPoint,
        fragments,
      });
    }
  }
  trace.push(`resolved: ${lessons.length} lesson(s), ${lessons.reduce((n, l) => n + l.fragments.length, 0)} fragment(s)`);
  return {
    courseId: course.id,
    title: course.title,
    competency: course.competency,
    performer,
    lessons,
    compositionTrace: trace,
  };
}

// ── Directionality — rendering for a human vs. an agent audience ─────

export interface AudienceRendering {
  direction: PerformanceDirection;
  directionMeaning: string;
  audienceKind: PerformerKind;
  /** For a human audience — the lesson chain as presented. */
  humanDelivery?: { lessons: number; fragments: number; format: string };
  /** For an agent audience — the content as context descriptors the
   *  agent composes into its working context (not slides). */
  agentDelivery?: { contextDescriptors: number; ingestionNote: string };
  note: string;
}

/**
 * Render a resolved course for its audience. The four directionalities
 * differ only here — a human audience receives a lesson chain; an agent
 * audience receives the same fragments AS context descriptors it
 * composes into its own working context. The fragments are identical;
 * the delivery is a composition choice.
 */
export function forAudience(resolved: ResolvedCourse, author: Performer): AudienceRendering {
  const direction = directionOf(author.kind, resolved.performer.kind);
  const fragments = resolved.lessons.reduce((n, l) => n + l.fragments.length, 0);
  const base: AudienceRendering = {
    direction,
    directionMeaning: describeDirection(direction),
    audienceKind: resolved.performer.kind,
    note: '',
  };
  if (resolved.performer.kind === 'human') {
    base.humanDelivery = {
      lessons: resolved.lessons.length,
      fragments,
      format: 'a sequenced lesson chain — consumable in the dashboard or launched as a cmi5 AU into any LMS.',
    };
    base.note = 'Human audience: the syntagm is delivered as a paced lesson chain. Consumption emits xAPI statements back to the LRS, closing the evaluation loop.';
  } else {
    base.agentDelivery = {
      contextDescriptors: fragments,
      ingestionNote: 'Agent audience: each fragment is delivered as a typed context descriptor the agent merges into its working context via the composition algebra — not rendered as slides. A "playbook" is exactly this: a Course with an agent audience.',
    };
    base.note = 'Agent audience: there is no presentation layer. The agent ingests the fragments as context and the evaluation loop reads transfer off its trajectory steps, not off slide-advance events.';
  }
  return base;
}

// ── In-the-flow performance support — content as an affordance ──────

export interface InFlowSupport {
  /** The job-aid fragment surfaced. */
  fragment: GroundingFragment;
  /** The task context whose entry triggered the support. */
  triggerContext: string;
  /** Performance support is delivered as an affordance, never scheduled. */
  delivery: 'affordance-triggered';
  affordance: { action: string; surfacedWhen: string };
  note: string;
}

/**
 * Wrap a job-aid fragment as in-the-flow performance support. The novel
 * principle: this is the SAME fragment a course would use, but delivered
 * by an affordance attached to the work context — surfaced when the
 * performer (human or agent) enters the triggering task, not on a
 * training schedule. Delivery is `restriction(all-support, current-task)`.
 */
export function inFlowSupport(jobAid: GroundingFragment, triggerContext: string): InFlowSupport {
  return {
    fragment: jobAid,
    triggerContext,
    delivery: 'affordance-triggered',
    affordance: {
      action: 'urn:cg:action:foxxi:surface-performance-support',
      surfacedWhen: `the performer enters the work context "${triggerContext}"`,
    },
    note: 'Performance support is not a course. The job aid is the same grounding fragment instruction would use, but composed into the work context as an affordance — restriction of the support paradigm to the current syntagm position. Nothing is "carried in memory".',
  };
}

/** Author a job aid directly — the A2H in-the-flow path from a diagnosis. */
export function authorJobAid(input: {
  competencyPoint: string;
  body: string;
  authoredBy: Performer;
  triggerContext: string;
  provenance?: string;
}): InFlowSupport {
  const fragment = authorFragment({
    modality: 'job-aid',
    competencyPoint: input.competencyPoint,
    body: input.body,
    level: 'applied',
    authoredBy: input.authoredBy,
    ...(input.provenance ? { provenance: input.provenance } : {}),
  });
  return inFlowSupport(fragment, input.triggerContext);
}

// ── Bridge to the cmi5 LMS layer ────────────────────────────────────

export interface Cmi5Outline {
  courseId: string;
  courseTitle: string;
  blocks: Array<{ id: string; title: string; aus: Array<{ id: string; title: string; moveOn: string }> }>;
}

/**
 * Project an emergent Course onto a cmi5 course-structure outline —
 * modules become blocks, lessons become Assignable Units. This is the
 * Foxxi composition layer in action: the emergent content composes
 * straight into the cmi5 LMS launch contract (cmi5-lms.ts), so a course
 * that emerged from a diagnosis can be launched into any cmi5 LMS.
 */
export function courseToCmi5Outline(course: Course): Cmi5Outline {
  return {
    courseId: course.id,
    courseTitle: course.title,
    blocks: course.syntagm.map(modulePos => {
      const module = modulePos.paradigm[0]!;
      return {
        id: module.id,
        title: module.title,
        aus: module.syntagm.map(lessonPos => {
          const lesson = lessonPos.paradigm[0]!;
          return { id: lesson.id, title: lesson.title, moveOn: course.moveOn };
        }),
      };
    }),
  };
}

// ── Scaffolding content from an intervention plan ───────────────────

export interface ContentScaffold {
  gapId?: string;
  /** Whether the plan actually calls for authored content. */
  contentWarranted: boolean;
  direction?: PerformanceDirection;
  /** What to author, derived from the selected interventions. */
  toAuthor: Array<{ interventionType: string; affordance: string; competency: string; guidance: string }>;
  note: string;
}

/**
 * Read an InterventionPlan and scaffold what content (if any) should be
 * authored — the join point between the diagnosis spine and the authoring
 * tools. If the plan selected only non-content interventions, the
 * scaffold is honestly empty.
 */
export function scaffoldFromPlan(plan: InterventionPlan, competency: string): ContentScaffold {
  const toAuthor = plan.selected
    .filter(o => !!o.authoring)
    .map(o => ({
      interventionType: o.type,
      affordance: o.authoring!.affordance,
      competency,
      guidance: o.type === 'instruction'
        ? 'Compose a course: a syntagm of modules → lessons → grounding fragments, cognitive-level-sequenced. Author the fragments first, then compose upward.'
        : o.type === 'performance-support'
          ? 'Author a single job aid fragment and wrap it with inFlowSupport — surfaced by an affordance at the point of work, not scheduled.'
          : o.type === 'assessment'
            ? 'Author assessment-item fragments that measure the competency; these promote the gap from Hypothetical to Asserted.'
            : `Author ${o.type} content for the competency.`,
    }));
  return {
    gapId: plan.gapId,
    contentWarranted: plan.contentWarranted,
    ...(plan.contentWarranted ? { direction: plan.direction } : {}),
    toAuthor,
    note: plan.contentWarranted
      ? `${toAuthor.length} content artifact(s) to author, ${describeDirection(plan.direction)}`
      : 'The diagnosis selected only non-content interventions — nothing to author. This is the system working as intended: content is an outcome of diagnosis, never an assumption.',
  };
}
