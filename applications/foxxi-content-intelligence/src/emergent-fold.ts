/**
 * An emergent course (emergent-content.ts) folded into composable content (content-fragments.ts,
 * compositions.ts).
 *
 * The older model already had the shape: a course is a syntagm of modules, a module of lessons, a
 * lesson of grounding fragments, and every position a paradigm of alternatives. But it lived in
 * memory, under ids nothing could check, and its packages graded in the browser. Folded, each
 * level is a composition over content-addressed fragments. It resolves per learner, plays step by
 * step, learns which alternatives work, and projects as cmi5.
 *
 * ★ THE SHAPE IS KEPT. Every syntagm becomes a composition's positions and every paradigm its
 * alternatives, in the author's order. A lesson, a module and a course are one composition each,
 * nested by reference.
 *
 * ★ A COMPETENCY IS THE TEXT ITS AUTHOR WROTE. The older model names competencies in free text
 * ("refund authority thresholds"). The competency's id is that text, exactly: its IRI carries it,
 * percent-encoded, and gives it back (competency-identity.ts). Nothing is slugged or guessed.
 *
 * ★ A CHECK IS GRADED ON THE BRIDGE. An assessment fragment in the older model is written
 * "question ::: answer — why". Folded, its answer becomes a verifier (course-questions.ts) for the
 * answer as written and for the answer without a leading article ("team lead" for "a team lead"),
 * and the part after the dash is the explanation shown once it is answered. The older model's
 * pages matched answers more loosely, in the browser.
 *
 * ★ WHAT IS NOT CARRIED. The audience a course was composed for, since a composition serves a
 * person and an agent alike; its moveOn, since a play grades each step; and its ids, which named
 * nothing checkable (the fold answers which IRI each one became). A fragment's suitability for a
 * disposition is carried as a suit.
 */
import { COMPOSITION_LIMITS, compositionFrom, type Composition } from './compositions.js';
import { ContentError, fragmentFrom, type Fragment } from './content-fragments.js';
import { competencyIri } from './competency-identity.js';
import type { Course, GroundingFragment, Lesson, Module } from './emergent-content.js';
import { explainedAnswer } from './scorm-assessment.js';

/** How much one fold makes at most: fragments and compositions, each counted once. */
export const EMERGENT_FOLD_LIMITS = { fragments: 2000, compositions: 500 } as const;

export interface FoldedEmergent {
  root: Composition;
  /** Every fragment and composition the fold made, the course last; each once. */
  items: Array<Fragment | Composition>;
  /** Which IRI each of the older model's ids became. */
  mapped: Record<string, string>;
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const text = (x: unknown, what: string): string => {
  if (typeof x !== 'string' || !x.trim()) throw new ContentError(`${what} must be a non-empty string`);
  return x.trim();
};
const fitted = (title: string): string => (title.length <= COMPOSITION_LIMITS.title ? title : `${title.slice(0, COMPOSITION_LIMITS.title - 1).trimEnd()}…`);

/** The competency an author named in free text: its id is the text itself. */
const competencyOf = (x: unknown, what: string): string => competencyIri(text(x, what));

function positionsOf(level: Record<string, unknown>, what: string): Array<{ competencyPoint: unknown; paradigm: unknown[] }> {
  if (!Array.isArray(level.syntagm)) throw new ContentError(`${what} has no syntagm`);
  return level.syntagm.map((p, i) => {
    if (!isObject(p) || !Array.isArray(p.paradigm) || !p.paradigm.length) throw new ContentError(`${what}, position ${i + 1}, has no paradigm`);
    return { competencyPoint: p.competencyPoint, paradigm: p.paradigm };
  });
}

export function foldEmergentCourse(raw: unknown, opts: { blindFor?: (fragmentId: string) => string | undefined } = {}): FoldedEmergent {
  if (!isObject(raw)) throw new ContentError('an emergent course is an object, as POST /content/compose-course returns one');
  const course = raw as unknown as Course;
  const items = new Map<string, Fragment | Composition>();
  const mapped: Record<string, string> = {};
  let fragments = 0;
  let compositions = 0;
  const keep = <T extends Fragment | Composition>(item: T, olderId: unknown): T => {
    if (!items.has(item['@id'])) {
      if ('positions' in item) { if (++compositions > EMERGENT_FOLD_LIMITS.compositions) throw new ContentError(`a fold makes at most ${EMERGENT_FOLD_LIMITS.compositions} compositions`); }
      else if (++fragments > EMERGENT_FOLD_LIMITS.fragments) throw new ContentError(`a fold makes at most ${EMERGENT_FOLD_LIMITS.fragments} fragments`);
    }
    items.set(item['@id'], item);
    if (typeof olderId === 'string' && olderId) mapped[olderId] = item['@id'];
    return item;
  };

  const fragment = (g: GroundingFragment, where: string): Fragment => {
    if (!isObject(g)) throw new ContentError(`${where} is not a fragment`);
    const competencies = [competencyOf(g.competencyPoint, `${where}: competencyPoint`)];
    const suits = typeof g.suitsDisposition === 'string' && g.suitsDisposition.trim() ? { suits: [g.suitsDisposition.trim().slice(0, 60)] } : {};
    const blind = typeof g.id === 'string' ? opts.blindFor?.(g.id) : undefined;
    try {
      if (g.modality === 'assessment-item') {
        const body = text(g.body, `${where}: body`);
        const at = body.indexOf(':::');
        if (at < 0) throw new ContentError('an assessment is written "question ::: answer"');
        const question = text(body.slice(0, at), 'its question');
        const { key, why } = explainedAnswer(body.slice(at + 3));
        const answer = text(key, 'its answer');
        const bare = answer.replace(/^(a|an|the)\s+/i, '');
        return keep(fragmentFrom({
          kind: 'assessment-item', level: g.level, competencies, body: question, ...suits, ...(blind ? { blind } : {}),
          questions: [{ question, answer, ...(bare !== answer ? { accept: [bare] } : {}), ...(why ? { explanation: why } : {}) }],
        }), g.id);
      }
      return keep(fragmentFrom({ kind: g.modality, level: g.level, competencies, body: g.body, ...suits }), g.id);
    } catch (e) {
      if (e instanceof ContentError) throw new ContentError(`${where}: ${e.message}`);
      throw e;
    }
  };

  const composition = (level: Record<string, unknown>, where: string, alternative: (x: unknown, at: string) => string): Composition => {
    const positions = positionsOf(level, where).map((p, i) => ({
      competency: competencyOf(p.competencyPoint, `${where}, position ${i + 1}: competencyPoint`),
      paradigm: p.paradigm.map((x, k) => alternative(x, `${where}, position ${i + 1}, alternative ${k + 1}`)),
    }));
    try {
      return keep(compositionFrom({ title: fitted(text(level.title, `${where}: title`)), competency: competencyOf(level.competency, `${where}: competency`), positions }), level.id);
    } catch (e) {
      if (e instanceof ContentError) throw new ContentError(`${where}: ${e.message}`);
      throw e;
    }
  };

  const lesson = (l: unknown, where: string): string => {
    if (!isObject(l)) throw new ContentError(`${where} is not a lesson`);
    return composition(l, where, (g, at) => fragment(g as GroundingFragment, at)['@id'])['@id'];
  };
  const module = (m: unknown, where: string): string => {
    if (!isObject(m)) throw new ContentError(`${where} is not a module`);
    return composition(m, where, (l, at) => lesson(l as Lesson, at))['@id'];
  };
  const root = composition(course as unknown as Record<string, unknown>, 'the course', (m, at) => module(m as Module, at));
  items.delete(root['@id']);
  return { root, items: [...items.values(), root], mapped };
}
