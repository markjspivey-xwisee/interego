/** Native course authoring. Content is a composition; xAPI is its record, SCORM is optional. */
import { compositionFrom, COMPOSITION_LIMITS, type Composition } from './compositions.js';
import { competencyRef, ContentError, contentRefOf, fragmentFrom, publicFragment, type Fragment } from './content-fragments.js';
import { isCompositionItem, type ContentItem } from './content-store.js';
import { sameCompetency } from './competency-identity.js';

export const XAPI_COURSE_LIMITS = { modules: 100, lessons: 100, fragments: 500 } as const;
export interface AuthoredXapiCourse { root: Composition; items: ContentItem[]; modules: number; lessons: number; }

const object = (raw: unknown, name: string): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ContentError(`${name} must be an object`);
  return raw as Record<string, unknown>;
};
const title = (raw: unknown, name: string): string => {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > COMPOSITION_LIMITS.title) throw new ContentError(`${name} is a non-empty title of at most ${COMPOSITION_LIMITS.title} characters`);
  return raw.trim();
};
const list = (raw: unknown, name: string, max: number): unknown[] => {
  if (!Array.isArray(raw) || !raw.length || raw.length > max) throw new ContentError(`${name} lists 1 to ${max} items`);
  return raw;
};

/**
 * Validate and author the whole hierarchy before any write. Each lesson supplies ordered
 * fragments in the same form as content_fragment. Graded answers become blinded verifiers
 * through fragmentFrom; no manifest or SCORM sequencing engine is involved.
 * A revision has a new content identity, and may name an earlier root in supersedes.
 */
export function authorXapiCourse(raw: unknown): AuthoredXapiCourse {
  const course = object(raw, 'course');
  const courseTitle = title(course.title, 'course.title');
  const competency = competencyRef(course.competency, 'course.competency');
  const items = new Map<string, ContentItem>();
  const keep = <T extends ContentItem>(item: T): T => { items.set(item['@id'], item); return item; };
  let lessons = 0, fragments = 0;
  const modules = list(course.modules, 'course.modules', XAPI_COURSE_LIMITS.modules).map((rawModule, mi) => {
    const module = object(rawModule, `modules[${mi}]`);
    const moduleTitle = title(module.title, `modules[${mi}].title`);
    const moduleCompetency = module.competency === undefined ? competency : competencyRef(module.competency, `modules[${mi}].competency`);
    const lessonPositions = list(module.lessons, `modules[${mi}].lessons`, XAPI_COURSE_LIMITS.lessons).map((rawLesson, li) => {
      if (++lessons > XAPI_COURSE_LIMITS.lessons) throw new ContentError(`a course has at most ${XAPI_COURSE_LIMITS.lessons} lessons in total`);
      const lesson = object(rawLesson, `modules[${mi}].lessons[${li}]`);
      const lessonTitle = title(lesson.title, `lessons[${li}].title`);
      const lessonCompetency = lesson.competency === undefined ? moduleCompetency : competencyRef(lesson.competency, `lessons[${li}].competency`);
      const positions = list(lesson.fragments, `lessons[${li}].fragments`, COMPOSITION_LIMITS.positions).map((rawFragment, fi) => {
        if (++fragments > XAPI_COURSE_LIMITS.fragments) throw new ContentError(`a course has at most ${XAPI_COURSE_LIMITS.fragments} fragments in total`);
        const input = object(rawFragment, `fragments[${fi}]`);
        // An omitted competency inherits its lesson. Explicit competencies retain their meaning.
        const fragment: Fragment = keep(fragmentFrom({ ...input, ...(input.competencies === undefined && input.competency === undefined ? { competencies: [lessonCompetency] } : {}) }));
        // Resolution and grading credit the position's competency. A fragment for another
        // competency must belong to a lesson for that competency, rather than be mislabeled.
        if (!fragment.competencies.some(c => sameCompetency(c, lessonCompetency))) throw new ContentError(`fragments[${fi}] must include its lesson competency; give the lesson that competency or include it on the fragment`);
        return { competency: lessonCompetency, paradigm: [fragment['@id']] };
      });
      const authored = keep(compositionFrom({ title: lessonTitle, competency: lessonCompetency, positions }));
      return { competency: lessonCompetency, paradigm: [authored['@id']] };
    });
    const authored = keep(compositionFrom({ title: moduleTitle, competency: moduleCompetency, positions: lessonPositions }));
    return { competency: moduleCompetency, paradigm: [authored['@id']] };
  });
  const root = keep(compositionFrom({ title: courseTitle, competency, positions: modules, ...(course.supersedes !== undefined ? { supersedes: course.supersedes } : {}) }));
  return { root, items: [...items.values()], modules: modules.length, lessons };
}

/** Followable artifacts of the SAME native composition, without allocating an attempt. */
export interface XapiCourseLinks { course: string; hypermarkdown: string; xapi: string; profile: string; cmi5: string; scorm: string; }
export function xapiCourseLinks(root: Composition, base: string): XapiCourseLinks {
  const ref = contentRefOf(root['@id']);
  if (!ref || ref.type !== 'composition') throw new ContentError('a native course has a composition identity');
  const url = `${base.replace(/\/+$/, '')}/ns/foxxi/composition/${ref.hash}`;
  return { course: url, hypermarkdown: `${url}?format=markdown`, xapi: `${url}/xapi.json`, profile: `${base.replace(/\/+$/, '')}/xapi/profile`, cmi5: `${url}/cmi5.xml`, scorm: `${url}/scorm.zip` };
}

/**
 * An answer-safe, lossless PUBLIC-content export. This product-specific descriptor is not an
 * xAPI-standard package, a portable grading-key archive, or a self-contained/offline player.
 * It describes the hosted native engine and retains every reachable fragment/composition.
 */
export function xapiCourseArtifact(root: Composition, lookup: (iri: string) => ContentItem | undefined, base: string): Record<string, unknown> {
  const seen = new Set<string>(), content: unknown[] = [], pending: ContentItem[] = [root];
  while (pending.length) {
    const item = pending.shift()!;
    if (seen.has(item['@id'])) continue;
    seen.add(item['@id']);
    if (seen.size > 5000) throw new ContentError('the course export reaches more than 5000 items');
    if (isCompositionItem(item)) {
      content.push(item);
      for (const iri of item.positions.flatMap(p => p.paradigm)) {
        const child = lookup(iri);
        if (!child) throw new ContentError(`course content is unavailable: ${iri}`);
        pending.push(child);
      }
    } else content.push(publicFragment(item));
  }
  const links = xapiCourseLinks(root, base);
  return {
    format: 'foxxi-native-xapi-course/v1', course: root, content,
    tracking: { version: '2.0.0', profile: links.profile, verbs: ['experienced', 'answered', 'completed'].map(v => `http://adlnet.gov/expapi/verbs/${v}`), grading: 'Server grades stored question verifiers; completing content is not itself a passing assessment.' },
    launch: { affordance: 'urn:iep:action:foxxi:content-launch-signed', tool: 'foxxi.content_launch', payload: { composition: root['@id'] }, continuation: { tool: 'foxxi.content_next', expected_step: 'Use the returned step.step; keep it unchanged on retries. The latest receipt is retained only within the in-process session TTL and capacity.' } },
    artifacts: links,
    note: 'A hosted native xAPI course descriptor. Public content omits grading verifiers and answer keys. Its native launch uses the existing signed composition engine; cmi5 and SCORM are separate projections.',
  };
}
