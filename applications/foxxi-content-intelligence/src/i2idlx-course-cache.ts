/** Request/session-local instructional graph. No inferred prerequisite or mastery claims. */
import { createHash } from 'node:crypto';

export type CourseSection = { id: string; title: string; body: string; source_uri?: string; locator?: string };
export type CourseMaterial = { id: string; title: string; kind: string; source_uri: string; version: string; sections: CourseSection[]; missing_context: string[] };
export type CourseGraph = {
  nodes: Array<{ id: string; type: 'course' | 'section' | 'heading'; label: string; section_id?: string }>;
  edges: Array<{ from: string; to: string; relation: 'contains' | 'next-in-source' | 'has-heading'; basis: 'published-structure' }>;
  source_id: string; source_version: string;
};
export type CachedCourse = {
  material: CourseMaterial; graph: CourseGraph; archiveDigest: string; contentDigest: string;
  storedAt: number; expires: number; bytes: number;
};

export function buildCourseGraph(material: CourseMaterial): CourseGraph {
  const root = 'course:' + material.id;
  const graph: CourseGraph = { source_id: material.id, source_version: material.version,
    nodes: [{ id: root, type: 'course', label: material.title }], edges: [] };
  const headings = new Set<string>();
  let previous: string | undefined;
  for (const section of material.sections) {
    const id = root + '#section:' + encodeURIComponent(section.id);
    const heading = root + '#heading:' + createHash('sha256').update(section.title).digest('hex');
    graph.nodes.push({ id, type: 'section', label: section.title, section_id: section.id });
    if (!headings.has(heading)) { headings.add(heading); graph.nodes.push({ id: heading, type: 'heading', label: section.title }); }
    graph.edges.push({ from: root, to: id, relation: 'contains', basis: 'published-structure' },
      { from: id, to: heading, relation: 'has-heading', basis: 'published-structure' });
    if (previous) graph.edges.push({ from: previous, to: id, relation: 'next-in-source', basis: 'published-structure' });
    previous = id;
  }
  return graph;
}

/** Lexical seeds expanded through observed order and shared source headings. */
export function graphCourseSections(cache: CachedCourse, question: string): { sections: CourseSection[]; seeds: string[]; expanded: string[] } {
  const stop = new Set(['the', 'and', 'for', 'what', 'which', 'when', 'where', 'how', 'does', 'this', 'that', 'with', 'your', 'from', 'about', 'please']);
  const terms = [...new Set(question.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter(t => t.length > 2 && !stop.has(t)))].slice(0, 64);
  const rows = cache.material.sections;
  const scores = rows.map((section, index) => ({ index, score: terms.reduce((sum, term) => sum +
    ((section.id + ' ' + section.title).toLowerCase().includes(term) ? 4 : 0) + (section.body.slice(0, 6000).toLowerCase().includes(term) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const seedIndexes = scores.filter(row => row.score > 0).slice(0, 8).map(row => row.index);
  if (!seedIndexes.length) seedIndexes.push(...scores.slice(0, 8).map(row => row.index));
  const indexes = new Set(seedIndexes);
  const rowIndexes = new Map(rows.map((section, index) => [section.id, index]));
  const nodeIndexes = new Map(cache.graph.nodes.filter(node => node.type === 'section' && node.section_id !== undefined)
    .flatMap(node => rowIndexes.has(node.section_id!) ? [[node.id, rowIndexes.get(node.section_id!)!] as const] : []));
  const seedNodes = new Set([...nodeIndexes].filter(([, index]) => indexes.has(index)).map(([id]) => id));
  const edges = cache.graph.edges.filter(edge => edge.basis === 'published-structure');
  const headingNodes = new Set(edges.filter(edge => edge.relation === 'has-heading' && seedNodes.has(edge.from)).map(edge => edge.to));
  const neighbors = new Set<number>();
  for (const edge of edges) {
    if (edge.relation === 'next-in-source') {
      if (seedNodes.has(edge.from) && nodeIndexes.has(edge.to)) neighbors.add(nodeIndexes.get(edge.to)!);
      if (seedNodes.has(edge.to) && nodeIndexes.has(edge.from)) neighbors.add(nodeIndexes.get(edge.from)!);
    }
    if (edge.relation === 'has-heading' && headingNodes.has(edge.to) && nodeIndexes.has(edge.from)) neighbors.add(nodeIndexes.get(edge.from)!);
  }
  for (const index of [...neighbors].sort((a, b) => a - b)) { if (indexes.size >= 24) break; indexes.add(index); }
  const chosen = [...indexes].sort((a, b) => a - b);
  return { sections: chosen.map(index => rows[index]!), seeds: seedIndexes.map(index => rows[index]!.id),
    expanded: chosen.filter(index => !seedIndexes.includes(index)).map(index => rows[index]!.id) };
}

export function courseCacheBytes(material: CourseMaterial, graph: CourseGraph): number {
  return Buffer.byteLength(JSON.stringify({ material, graph }), 'utf8');
}

/** Drop references and overwrite mutable text fields; JS/runtime copies are not promised zeroized. */
export function clearCourseCache(cache: CachedCourse): void {
  for (const section of cache.material.sections) section.body = '';
  cache.material.sections.length = 0; cache.material.missing_context.length = 0;
  cache.graph.nodes.length = 0; cache.graph.edges.length = 0;
}
