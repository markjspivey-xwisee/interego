import { describe, expect, it } from 'vitest';
import { buildCourseGraph, graphCourseSections, clearCourseCache, courseCacheBytes, type CachedCourse, type CourseMaterial } from '../src/i2idlx-course-cache.js';

const material = (): CourseMaterial => ({ id: 'a'.repeat(64), title: 'Published procedure', kind: 'Course', source_uri: 'urn:fixture:course', version: 'v1',
  sections: Array.from({ length: 30 }, (_, i) => ({ id: 'page-' + i, title: i === 16 ? 'Beacon fault' : 'Section ' + i,
    body: i === 16 ? 'Record BLUE-27 in the log.' : 'Published instructional text ' + i, source_uri: 'urn:fixture:course:page:' + i })), missing_context: [] });
const cache = (): CachedCourse => {
  const source = material(), graph = buildCourseGraph(source);
  return { material: source, graph, contentDigest: 'b'.repeat(64), archiveDigest: 'c'.repeat(64), storedAt: 1, expires: 2, bytes: courseCacheBytes(source, graph) };
};
describe('local course content graph', () => {
  it('keeps real heading and source-order relationships without inventing semantic prerequisites', () => {
    const c = cache();
    expect(c.graph.nodes).toContainEqual(expect.objectContaining({ type: 'heading', label: 'Beacon fault' }));
    expect(c.graph.edges.filter(edge => edge.relation === 'next-in-source')).toHaveLength(29);
    expect(c.graph.edges.every(edge => edge.basis === 'published-structure')).toBe(true);
    expect(JSON.stringify(c.graph)).not.toMatch(/prerequisite|mastery|competent/);
  });
  it('retrieves a distant matching section and its observed neighbors instead of just taking the first pages', () => {
    const c = cache(), result = graphCourseSections(c, 'What happens during a beacon fault?');
    expect(result.seeds).toEqual(['page-16']);
    expect(result.expanded).toEqual(['page-15', 'page-17']);
    expect(result.sections.map(section => section.id)).toEqual(['page-15', 'page-16', 'page-17']);
    expect(result.sections[1]!.body).toContain('BLUE-27');
    c.graph.edges = c.graph.edges.filter(edge => edge.relation !== 'next-in-source');
    const withoutEdges = graphCourseSections(c, 'What happens during a beacon fault?');
    expect(withoutEdges.sections.map(section => section.id)).toEqual(['page-16']);
    expect(withoutEdges.expanded).toEqual([]);
  });
  it('bounds graph retrieval and drops retained text and graph references on deletion', () => {
    const c = cache(), sections = c.material.sections, graph = c.graph;
    expect(graphCourseSections(c, 'unrelated query').sections.length).toBeLessThanOrEqual(24);
    clearCourseCache(c);
    expect(sections).toEqual([]); expect(graph.nodes).toEqual([]); expect(graph.edges).toEqual([]);
    expect(JSON.stringify(c)).not.toContain('BLUE-27');
  });
});
