/**
 * A composed descriptor's identity comes from its content, and a bad operand is refused
 * with a message that says what was wanted.
 *
 * ★ WHY. Composed descriptors were identified by a PROCESS-LOCAL SEQUENTIAL COUNTER —
 * `urn:iep:composed:${++n}`. That fails in both directions at once:
 *
 *   - same content, DIFFERENT id: compose A∪B twice in one process → `…:1`, `…:2`
 *   - different content, SAME id: two unrelated compositions in two processes → both `…:1`
 *
 * and a restart makes `urn:iep:composed:1` name something else entirely. The lattice-law
 * checks in category.ts had to call resetComposedIdCounter() between every path just to
 * make two results comparable, which is the tell: the id was not an identity.
 *
 * ★ AND. `mint(kind:'descriptor')` accepted any value, hashed it, returned an IRI — then
 * compose() spread `data.facets` and a caller who passed that IRI back got
 * `Error: facets is not iterable` as their tool result. A raw TypeError across an API
 * boundary, naming an internal field, saying nothing about what was expected.
 */
import { describe, it, expect } from 'vitest';
import { union, intersection, restriction, override, kernel, descriptorProblem } from '@interego/core';

const desc = (id: string, graphs: string[], facets: unknown[]) =>
  ({ id, describes: graphs, facets, version: 1 }) as never;

const A = desc('https://ex.org/a', ['https://ex.org/g1'], [{ type: 'Temporal', validFrom: '2020-01-01T00:00:00Z' }]);
const B = desc('https://ex.org/b', ['https://ex.org/g2'], [{ type: 'Trust', level: 'high' }]);
const C = desc('https://ex.org/c', ['https://ex.org/g3'], [{ type: 'Agent', agent: 'did:web:x' }]);

describe('composed descriptor identity is content-addressed', () => {
  it('the same composition always yields the same id', () => {
    expect(union(A, B).id).toBe(union(A, B).id);
    expect(intersection(A, B).id).toBe(intersection(A, B).id);
  });

  it('different operands yield different ids', () => {
    expect(union(A, B).id).not.toBe(union(A, C).id);
  });

  it('the operator is part of the identity', () => {
    expect(union(A, B).id).not.toBe(intersection(A, B).id);
  });

  it('restriction distinguishes the projected type set', () => {
    expect(restriction(A, ['Temporal'] as never).id)
      .not.toBe(restriction(A, ['Trust'] as never).id);
  });

  it('override is distinguishable from union of the same pair', () => {
    expect(override(A, B).id).not.toBe(union(A, B).id);
  });

  it('no id is a bare sequential counter', () => {
    // The old scheme produced urn:iep:composed:1, :2, :3 …
    for (const id of [union(A, B).id, intersection(A, B).id, override(A, C).id]) {
      expect(id, `${id} looks like a counter`).not.toMatch(/^urn:iep:composed:\d{1,6}$/);
      expect(id).toMatch(/^urn:iep:composed:[0-9a-f]{40}$/);
    }
  });

  it('an explicit id still wins, so callers can name a composition', () => {
    expect(union(A, B, 'https://ex.org/mine' as never).id).toBe('https://ex.org/mine');
  });
});

describe('a malformed descriptor is refused, not leaked as a TypeError', () => {
  it('names the problem for each bad shape', () => {
    expect(descriptorProblem('urn:iep:descriptor:abc')).toMatch(/must be a descriptor OBJECT, not an IRI/);
    expect(descriptorProblem({ id: 'x', describes: [], facets: { a: 1 } })).toMatch(/facets \(an ARRAY/);
    expect(descriptorProblem({ hello: 'world' })).toMatch(/id .*describes .*facets/s);
    expect(descriptorProblem([1, 2, 3])).toMatch(/an array/);
    expect(descriptorProblem(null)).toMatch(/null/);
  });

  it('accepts a well-formed descriptor', () => {
    expect(descriptorProblem(A)).toBeNull();
  });

  it('compose refuses an IRI operand instead of spreading a non-iterable', () => {
    // The exact mistake: mint hands back an IRI, so passing it on is the natural move.
    expect(() => union('urn:iep:descriptor:abc' as never, A))
      .toThrow(/must be a descriptor OBJECT, not an IRI/);
    // …and specifically NOT the old leak.
    expect(() => union('urn:iep:descriptor:abc' as never, A))
      .not.toThrow(/facets is not iterable/);
  });

  it('mint(kind:descriptor) validates at the point the value enters', () => {
    expect(() => kernel.mint('not-a-descriptor', { kind: 'descriptor' }))
      .toThrow(/must be a descriptor OBJECT/);
    expect(() => kernel.mint({ facets: { nested: true } }, { kind: 'descriptor' }))
      .toThrow(/facets \(an ARRAY/);
    // A good one is unaffected.
    expect(kernel.mint(A, { kind: 'descriptor' }).holon.iri).toMatch(/^urn:iep:descriptor:[0-9a-f]{40}$/);
  });
});
