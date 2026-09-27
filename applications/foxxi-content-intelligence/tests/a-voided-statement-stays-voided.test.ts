/**
 * A learner's record is read from several copies of it: the lattice's, the store's and the pod's.
 * Only the store marks a void, as it applies one, so its mark is kept through the merge whichever
 * copy comes first: a voided play does not list a composition as played.
 *
 * A voiding statement is not replayed as a void. The store decided whether it took effect from
 * things its body does not say (whether its target was there yet; which registration its writer
 * was bound to), so reading its body again would decide differently: it could void a statement the
 * store holds as current, or spare one the store voided. The store's mark is the only word on it.
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

describe('a void the store applied, kept through the merge', () => {
  it("keeps the store's mark when the lattice's copy comes first, and changes nothing passed in", () => {
    const s = statement('a');
    const fromLattice = copy(s);
    const fromStore = copy(s, true);
    const merged = mergeStatementsById([fromLattice, fromStore], []);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'a', voided: true });
    expect(fromLattice.voided).toBe(false);
    expect(mergeStatementsById([copy(s)], [s])).toEqual([copy(s)]);   // nothing marked, nothing voided
  });

  it('keeps a void a Basic-auth writer applied, whatever registration its voider names', () => {
    // The store voided this r2 statement for a writer bound to no registration, though the voider says r1.
    const target = statement('b', { context: { registration: 'r2' } });
    const merged = mergeStatementsById([copy(target), copy(target, true), copy(voiding('v', 'b', 'r1'))], []);
    expect(voidedIds(merged)).toEqual(['b']);
  });
});

describe('a voiding statement is not replayed as a void', () => {
  it('leaves current a statement stored after the voider that named it, as the store holds it', () => {
    // The voider came first, voided nothing, and the statement it named arrived after: current.
    const merged = mergeStatementsById([copy(voiding('v', 'a')), copy(statement('a'))], [voiding('v', 'a')]);
    expect(voidedIds(merged)).toEqual([]);
  });

  it('voids nothing from a durable copy on its own, whatever it names', () => {
    const merged = mergeStatementsById([copy(statement('a')), copy(statement('b', { context: { registration: 'r1' } }))],
      [voiding('v1', 'a'), voiding('v2', 'b', 'r1'), voiding('v3', 'v1')]);
    expect(voidedIds(merged)).toEqual([]);
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

  it('lists it from a step no store voided, whatever voiding statement a copy holds', () => {
    expect(listed([copy(step('s1'))], [voiding('v', 's1')])).toEqual([root]);
  });
});
