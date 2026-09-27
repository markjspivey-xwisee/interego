/**
 * What a learner or an author has at hand, for a portal and for an agent alike: the compositions
 * they made and the ones they played, read from what is already kept; what they keep at each
 * competency; and, on a step, whether a missed check brought it in.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { StoredStatement } from '../src/statement-store.js';
import { authoredCompositions, playedCompositions } from '../src/content-listing.js';
import { compositionIri } from '../src/content-fragments.js';
import { AUTHORED_VERB } from '../src/learner-record.js';
import { PLAY_EXT, PLAY_TYPES, advancePlay, currentView, startPlay } from '../src/composition-play.js';
import { anotherAlternative, compositionFrom, resolveComposition, type Composition } from '../src/compositions.js';
import { fragmentFrom, type Fragment } from '../src/content-fragments.js';

const hash = (n: number) => String(n).padStart(64, '0');
const me = 'did:ethr:0x0000000000000000000000000000000000000001';
const other = 'did:ethr:0x0000000000000000000000000000000000000002';
const ELSEWHERE = (h: string) => `https://elsewhere.example/ns/foxxi/composition/${h}`;
let n = 0;
const rec = (statement: Record<string, unknown>, voided = false): StoredStatement =>
  ({ id: `s${++n}`, stored: String(statement.timestamp ?? '2026-09-27T00:00:00Z'), voided, statement }) as unknown as StoredStatement;
const authored = (iri: string, title: string, at: string) => rec({
  verb: { id: AUTHORED_VERB }, timestamp: at,
  object: { id: iri, definition: { type: PLAY_TYPES.composition, name: { en: title } } },
});
const training = (extra: Record<string, unknown> = {}) => ({ extensions: { [PLAY_EXT.contextKind]: 'training' }, ...extra });
const experienced = (root: string, at: string, holder?: string) => rec({
  verb: { id: 'http://adlnet.gov/expapi/verbs/experienced' }, timestamp: at,
  object: { id: 'urn:x:fragment', definition: { type: PLAY_TYPES.fragment } },
  context: training({ contextActivities: holder
    ? { parent: [{ id: holder }], grouping: [{ id: root }] }
    : { parent: [{ id: root }] } }),
});
const completed = (iri: string, title: string, at: string, raw?: number, max?: number) => rec({
  verb: { id: 'http://adlnet.gov/expapi/verbs/completed' }, timestamp: at,
  object: { id: iri, definition: { type: PLAY_TYPES.composition, name: { en: title } } },
  result: { completion: true, ...(raw !== undefined ? { score: { raw, max } } : {}) },
  context: training(),
});

describe('the compositions an author has made', () => {
  const locations = new Map([
    [`composition:${hash(1)}`, [{ did: me, pod: 'https://pod.example/me/' }]],
    [`fragment:${hash(2)}`, [{ did: me, pod: 'https://pod.example/me/' }]],
    [`composition:${hash(3)}`, [{ did: other, pod: 'https://pod.example/other/' }]],
    [`composition:${hash(4)}`, [{ did: other, pod: '' }, { did: me, pod: '' }]],
    [`composition:${hash(5)}`, [{ did: me, pod: '' }]],
  ]);

  it('come from the index of where content lives, theirs only, compositions only', () => {
    expect(authoredCompositions([], locations, me, 10).map(c => c.iri)).toEqual([hash(5), hash(4), hash(1)].map(compositionIri));
  });

  it('are marked as roots, with a time and title, where their authoring record is at hand, those first', () => {
    const statements = [
      authored(ELSEWHERE(hash(1)), 'Refunds', '2026-09-20T00:00:00Z'),   // named by another authority, the same hash
      authored(compositionIri(hash(3)), 'Not mine', '2026-09-27T00:00:00Z'),
      authored(compositionIri(hash(4)), 'Disputes', '2026-09-25T00:00:00Z'),
    ];
    expect(authoredCompositions(statements, locations, me, 10)).toEqual([
      { iri: compositionIri(hash(4)), title: 'Disputes', at: '2026-09-25T00:00:00Z', root: true },
      { iri: compositionIri(hash(1)), title: 'Refunds', at: '2026-09-20T00:00:00Z', root: true },
      { iri: compositionIri(hash(5)) },
    ]);
    expect(authoredCompositions(statements, locations, me, 2)).toHaveLength(2);
  });
});

describe('the compositions a learner has played', () => {
  it('are read from their plays: started from a step, finished with the latest score, the last played first', () => {
    const statements = [
      experienced(compositionIri(hash(1)), '2026-09-20T10:00:00Z'),
      experienced(ELSEWHERE(hash(2)), '2026-09-21T10:00:00Z', compositionIri(hash(9))),   // a nested step names its root first
      completed(compositionIri(hash(2)), 'Disputes', '2026-09-21T10:05:00Z', 1, 2),
      completed(compositionIri(hash(2)), 'Disputes', '2026-09-22T10:05:00Z', 2, 2),
      experienced(compositionIri(hash(3)), '2026-09-26T10:00:00Z'),
      rec({ ...experienced(compositionIri(hash(4)), '2026-09-27T10:00:00Z').statement }, true),   // voided
      rec({ verb: { id: 'http://adlnet.gov/expapi/verbs/completed' }, timestamp: '2026-09-27T11:00:00Z',
        object: { id: compositionIri(hash(5)), definition: { type: PLAY_TYPES.composition } }, context: { extensions: { [PLAY_EXT.contextKind]: 'production' } } }),
    ];
    expect(playedCompositions(statements, 10)).toEqual([
      { iri: compositionIri(hash(3)), at: '2026-09-26T10:00:00Z', finished: false },
      { iri: compositionIri(hash(2)), at: '2026-09-22T10:05:00Z', finished: true, title: 'Disputes', score: { raw: 2, max: 2 } },
      { iri: compositionIri(hash(1)), at: '2026-09-20T10:00:00Z', finished: false },
    ]);
    expect(playedCompositions(statements, 1)).toHaveLength(1);
  });
});

describe('a step a missed check brought in says so', () => {
  it('as another way in, or another check, and an ordinary step does not', () => {
    const c = 'refund-authority';
    const explain = fragmentFrom({ kind: 'concept', level: 'foundational', competencies: [c], title: 'Who approves', body: 'Agents refund up to $250.' });
    const example = fragmentFrom({ kind: 'worked-example', level: 'foundational', competencies: [c], title: 'A $600 request', body: 'A $600 request goes to the team lead.' });
    const check = (title: string) => fragmentFrom({ kind: 'assessment-item', competencies: [c], title, body: 'Check.', questions: [{ question: `${title}?`, options: ['Agent', 'Team lead'], answer: 'B' }] });
    const [check1, check2] = [check('Check'), check('Check again')];
    const comp = compositionFrom({ title: 'Refunds', competency: c, positions: [
      { competency: c, paradigm: [explain['@id'], example['@id']] }, { competency: c, paradigm: [check1['@id'], check2['@id']] },
    ] });
    const store = new Map<string, Fragment | Composition>([explain, example, check1, check2, comp].map(x => [x['@id'], x]));
    const learner = { id: me, kind: 'human' as const };
    const play = startPlay(resolveComposition({ composition: comp, learner, lookup: i => store.get(i) }), comp.title, learner, { session: 's', registration: 'r' }, '2026-09-27T00:00:00Z')!;
    const choose = (step: Parameters<typeof anotherAlternative>[0], exclude: ReadonlySet<string>) => anotherAlternative(step, { lookup: i => store.get(i), learnerKind: 'human', exclude });
    const ctx = { actor: { objectType: 'Agent' }, now: '2026-09-27T00:00:00Z', newId: () => crypto.randomUUID() };
    expect(currentView(play)).not.toHaveProperty('wayIn');
    advancePlay(play, undefined, ctx, choose);
    advancePlay(play, ['A'], ctx, choose);
    expect(currentView(play)).toMatchObject({ wayIn: 'teaching', fragment: { title: 'A $600 request' } });
    advancePlay(play, undefined, ctx, choose);
    expect(currentView(play)).toMatchObject({ wayIn: 'check', fragment: { title: 'Check again' } });
  });
});

describe('the bridge answers each for the caller themselves', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  const route = (path: string) => { const at = src.indexOf(`app.post('${path}'`); return src.slice(at, src.indexOf('\n});', at)); };

  it('lists their compositions from their own record, and the index read first, or answers that it cannot be', () => {
    const mine = route('/agent/content/mine');
    expect(mine).toMatch(/const auth = await verifyDelegatedCaller\(req\.body\);/);
    expect(mine).toMatch(/if \(!\(await contentLocationsReader\.load\(\)\)\) \{\s+res\.status\(503\)/);
    expect(mine.indexOf('contentLocationsReader.load()')).toBeLessThan(mine.indexOf('authoredCompositions('));
    expect(mine).toMatch(/learnerStatementsFor\(resolveSubjectPodUrl\(auth\.callerDid\), auth\.callerDid\)/);
    expect(mine).toMatch(/authoredCompositions\(statements, contentLocations, auth\.callerDid, limit\)/);
    expect(mine).toMatch(/Math\.min\(Math\.max\(asked, 1\), 200\) : 50/);
  });

  it('reads back what they keep, and an unreadable list is not an empty one', () => {
    const admissions = route('/agent/content/admissions');
    expect(admissions).toMatch(/const kept = await learnerAdmissions\(auth\.callerDid\);\s+if \(!kept\.ok\) \{ res\.status\(503\)/);
  });
});
