/**
 * A learner's record is read from several copies of it: the lattice's, the store's and the pod's.
 * Only the store marks a void, so a void is kept through the merge whichever copy comes first, and
 * a voiding statement any copy holds voids its target by the rules the store voids by. So a voided
 * play does not list a composition as played, after a restart that emptied the store included.
 */
import { describe, expect, it } from 'vitest';
import { mergeStatementsById, type StoredStatementLike } from '../src/durable-records.js';
import { playedCompositions } from '../src/content-listing.js';
import { compositionIri } from '../src/content-fragments.js';
import { PLAY_EXT, PLAY_TYPES } from '../src/composition-play.js';
import type { StoredStatement } from '../src/statement-store.js';

const VOIDED = 'http://adlnet.gov/expapi/verbs/voided';
const statement = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, verb: { id: 'http://adlnet.gov/expapi/verbs/experienced' }, object: { id: 'urn:x:thing' }, timestamp: '2026-09-27T10:00:00Z', ...extra,
});
const voiding = (id: string, target: string, registration?: string): Record<string, unknown> => ({
  id, verb: { id: VOIDED }, object: { objectType: 'StatementRef', id: target }, timestamp: '2026-09-27T11:00:00Z',
  ...(registration ? { context: { registration } } : {}),
});
const copy = (s: Record<string, unknown>, voided = false): StoredStatementLike => ({ id: String(s.id), statement: s, stored: String(s.timestamp), voided });
const voidedIds = (records: StoredStatementLike[]) => records.filter(r => r.voided).map(r => r.id);

describe('a void kept through the merge', () => {
  it("keeps the store's mark when the lattice's copy comes first, and changes nothing passed in", () => {
    const s = statement('a');
    const fromLattice = copy(s);
    const fromStore = copy(s, true);
    const merged = mergeStatementsById([fromLattice, fromStore], []);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'a', voided: true });
    expect(fromLattice.voided).toBe(false);
  });

  it('voids a statement by a voiding statement any copy holds, after a restart that emptied the store', () => {
    const merged = mergeStatementsById([copy(statement('a'))], [voiding('v', 'a'), statement('b')]);
    expect(voidedIds(merged)).toEqual(['a']);
  });

  it('never voids another voiding statement', () => {
    const merged = mergeStatementsById([copy(voiding('v', 'a'))], [voiding('w', 'v')]);
    expect(voidedIds(merged)).toEqual([]);
  });

  it('voids by a voider that names a registration only a statement of that registration', () => {
    const merged = mergeStatementsById([
      copy(statement('same', { context: { registration: 'r1' } })),
      copy(statement('other', { context: { registration: 'r2' } })),
      copy(statement('any', { context: { registration: 'r2' } })),
    ], [voiding('v1', 'same', 'r1'), voiding('v2', 'other', 'r1'), voiding('v3', 'any')]);
    expect(voidedIds(merged)).toEqual(['same', 'any']);
  });

  it('voids by any one of several voiders that may void it, whichever comes first', () => {
    const target = copy(statement('a', { context: { registration: 'r2' } }));
    const [outside, inside] = [voiding('v1', 'a', 'r1'), voiding('v2', 'a', 'r2')];
    expect(voidedIds(mergeStatementsById([target], [outside, inside]))).toEqual(['a']);
    expect(voidedIds(mergeStatementsById([target], [inside, outside]))).toEqual(['a']);
  });
});

describe('a voided play in the listing', () => {
  const root = compositionIri('1'.repeat(64));
  const step = (id: string) => statement(id, {
    object: { id: 'urn:x:fragment', definition: { type: PLAY_TYPES.fragment } },
    context: { extensions: { [PLAY_EXT.contextKind]: 'training' }, contextActivities: { parent: [{ id: root }] } },
  });
  const listed = (lens: StoredStatementLike[], durable: Record<string, unknown>[]) =>
    playedCompositions(mergeStatementsById(lens, durable) as unknown as StoredStatement[], 10).map(c => c.iri);

  it('does not list a composition as played from a step the store voided, when the lattice holds it too', () => {
    expect(listed([copy(step('s1')), copy(step('s1'), true)], [])).toEqual([]);
  });

  it('does not list it from the step alone, once the store that voided it is gone', () => {
    expect(listed([copy(step('s1'))], [voiding('v', 's1')])).toEqual([]);
    expect(listed([copy(step('s1'))], [])).toEqual([root]);
  });
});
