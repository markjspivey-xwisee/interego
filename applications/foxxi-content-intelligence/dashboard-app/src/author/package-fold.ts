/**
 * What folding a SCORM package hosted here answers (POST /agent/content/fold-course with
 * package_sha256), as the Author page shows it: the composition it made, each topic's parts, and
 * what of the package was not read or not folded, with why.
 */
import { contentKindOf } from './compose.js';

export interface FoldedPackageView {
  /** The package's composition. */
  iri: string;
  title: string;
  topics: Array<{ title: string; pages: number; questions: number; folded: boolean }>;
  unread: Array<{ path: string; why: string }>;
  /** How many fragments and compositions the fold made. */
  items: number;
  /** Said when the package's questions became checks. */
  checks?: string;
}

/** The fold's answer, when it names a composition; its lists keep only well-formed entries. */
export function foldedPackageFrom(body: unknown): FoldedPackageView | null {
  const b = body as { '@id'?: unknown; composition?: { title?: unknown } | null; topics?: unknown; unread?: unknown; items?: unknown; checks?: unknown } | null;
  const iri = b?.['@id'];
  if (typeof iri !== 'string' || contentKindOf(iri) !== 'composition') return null;
  const topics: FoldedPackageView['topics'] = [];
  for (const t of Array.isArray(b?.topics) ? b.topics : []) {
    const topic = t as { title?: unknown; pages?: unknown; questions?: unknown; at?: unknown } | null;
    if (!topic || typeof topic.title !== 'string') continue;
    topics.push({
      title: topic.title,
      pages: Array.isArray(topic.pages) ? topic.pages.length : 0,
      questions: typeof topic.questions === 'number' ? topic.questions : 0,
      folded: typeof topic.at === 'string',
    });
  }
  const unread: FoldedPackageView['unread'] = [];
  for (const u of Array.isArray(b?.unread) ? b.unread : []) {
    const left = u as { path?: unknown; why?: unknown } | null;
    if (left && typeof left.path === 'string' && typeof left.why === 'string') unread.push({ path: left.path, why: left.why });
  }
  return {
    iri,
    title: typeof b?.composition?.title === 'string' ? b.composition.title : 'Untitled composition',
    topics, unread,
    items: typeof b?.items === 'number' ? b.items : 0,
    ...(typeof b?.checks === 'string' ? { checks: b.checks } : {}),
  };
}
