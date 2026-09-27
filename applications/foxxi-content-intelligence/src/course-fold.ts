/**
 * An authored course folded into composable content: fragments and compositions
 * (content-fragments.ts, compositions.ts) that resolve per learner, are played step by step, and
 * learn which alternatives work (fragment-efficacy.ts).
 *
 * ★ A SECTION'S TEACHING AND ITS CHECK BECOME TWO FRAGMENTS. A section holds its teaching, in
 * Markdown, and often questions on it. Folded, the teaching is a concept fragment and the questions
 * a check: an assessment item, or a reflection when nothing in it is graded. Kept apart, another
 * explanation can be offered at the teaching's position and the same check judges which one
 * works. Kept together, a section could only ever be measured against itself.
 *
 * ★ THE COURSE'S SHAPE IS KEPT. A section with both parts becomes a composition of its own,
 * teaching then check, at its position in the course's composition. A section with one part puts
 * that fragment there directly, and a section with neither is left out and listed. So a course's
 * sections map one to one onto a composition's positions.
 *
 * ★ THE QUESTIONS GRADE THE SAME. They are kept in the stored form they were authored in (verifiers,
 * salts, explanations), so an answer is right or wrong exactly as it was in the course. Each check
 * takes its blinding value from `blindFor`. When that is derived from a secret, folding the same
 * course again gives the same IRIs, and the value is never served (content-fragments.ts).
 *
 * ★ NOTHING IS INVENTED. Titles, bodies and questions are the author's own. The one exception is a
 * check's body, which a fragment must have: it is the section's title as a heading. A title longer
 * than a fragment's or a composition's is shortened to fit. The competency is the one named for the
 * course, or for a section. A course's mastery score is not carried: a play grades each step.
 */
import { COMPOSITION_LIMITS, compositionFrom, type Composition } from './compositions.js';
import { competencyRef, ContentError, FRAGMENT_LIMITS, fragmentFrom, type Fragment } from './content-fragments.js';
import type { CognitiveLevel } from './emergent-content.js';
import type { ScormAssessmentQuestion } from './scorm-assessment.js';

/** A course as the bridge keeps an authored one: its sections, each with Markdown and questions in stored form. */
export interface FoldableCourse {
  courseId: string;
  title: string;
  scos: ReadonlyArray<{ id: string; title: string; body: string; assessment?: readonly ScormAssessmentQuestion[] }>;
}

export interface FoldOptions {
  /** The competency the course develops: an IRI, another authority's term IRI, or a slug. */
  competency: string;
  /** A section's own competency, by section id, where it differs from the course's. */
  sectionCompetencies?: Readonly<Record<string, string>>;
  level?: CognitiveLevel;
  /** BCP 47 tag of the course's language. */
  language?: string;
  /** The blinding value for a section's check (64 hex characters); a random one when this answers undefined. */
  blindFor?: (sectionId: string) => string | undefined;
}

export interface FoldedSection {
  id: string;
  title: string;
  competency: string;
  /** The IRI at the section's position: its lesson, or its one fragment. Absent when the section held nothing. */
  at?: string;
  concept?: string;
  check?: string;
  /** The section's own composition, teaching then check, when it has both. */
  lesson?: string;
}

export interface FoldedCourse {
  root: Composition;
  /** Every fragment and composition the fold made, the root last; each once. */
  items: Array<Fragment | Composition>;
  sections: FoldedSection[];
}

/** A title shortened, at a word where it can be, to fit `max` characters. */
function fitted(title: string, max: number): string {
  const t = title.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function foldCourse(course: FoldableCourse, opts: FoldOptions): FoldedCourse {
  if (!course.scos.length) throw new ContentError('a course with no sections has nothing to fold');
  if (course.scos.length > COMPOSITION_LIMITS.positions) throw new ContentError(`a course folds into at most ${COMPOSITION_LIMITS.positions} positions`);
  const items = new Map<string, Fragment | Composition>();
  const keep = <T extends Fragment | Composition>(item: T): T => { items.set(item['@id'], item); return item; };
  const common = { level: opts.level ?? 'working', ...(opts.language ? { language: opts.language } : {}) };
  const courseCompetency = competencyRef(opts.competency, 'the competency of the course');

  const sections: FoldedSection[] = course.scos.map((sco, i) => {
    const where = `section ${i + 1} (${sco.id})`;
    const title = fitted(sco.title || sco.id, Math.min(FRAGMENT_LIMITS.title, COMPOSITION_LIMITS.title));
    try {
      // Only the map's own entries: a section called "constructor" names nothing inherited.
      const own = opts.sectionCompetencies && Object.prototype.hasOwnProperty.call(opts.sectionCompetencies, sco.id);
      const named = own ? opts.sectionCompetencies![sco.id] : undefined;
      const competency = named === undefined ? courseCompetency : competencyRef(named, 'its competency');
      const concept = sco.body.trim()
        ? keep(fragmentFrom({ kind: 'concept', ...common, competencies: [competency], title, body: sco.body }))
        : undefined;
      const questions = sco.assessment ?? [];
      const blind = opts.blindFor?.(sco.id);
      const check = questions.length
        ? keep(fragmentFrom({
          kind: questions.some(q => q.answerHash) ? 'assessment-item' : 'reflection', ...common,
          competencies: [competency], title, body: `## ${title}`, questions, ...(blind ? { blind } : {}),
        }))
        : undefined;
      const lesson = concept && check
        ? keep(compositionFrom({ title, competency, positions: [{ competency, paradigm: [concept['@id']] }, { competency, paradigm: [check['@id']] }] }))
        : undefined;
      const at = lesson ?? concept ?? check;
      return {
        id: sco.id, title, competency,
        ...(at ? { at: at['@id'] } : {}),
        ...(concept ? { concept: concept['@id'] } : {}),
        ...(check ? { check: check['@id'] } : {}),
        ...(lesson ? { lesson: lesson['@id'] } : {}),
      };
    } catch (e) {
      if (e instanceof ContentError) throw new ContentError(`${where}: ${e.message}`);
      throw e;
    }
  });

  const placed = sections.filter(s => s.at);
  if (!placed.length) throw new ContentError('no section has teaching or questions to fold');
  const root = compositionFrom({
    title: fitted(course.title || course.courseId, COMPOSITION_LIMITS.title), competency: courseCompetency,
    positions: placed.map(s => ({ competency: s.competency, paradigm: [s.at!] })),
  });
  items.delete(root['@id']);
  return { root, items: [...items.values(), root], sections };
}
