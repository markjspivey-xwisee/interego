/**
 * An emergent course folds into compositions: its syntagms and paradigms kept in the author's
 * order, a competency named by the very text its author wrote, and a check graded on the bridge
 * from its "question ::: answer — why".
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { advancePlay, startPlay } from '../src/composition-play.js';
import { compositionIsIntact, resolveComposition, type Composition } from '../src/compositions.js';
import { ContentError, fragmentIsIntact, publicFragment, type Fragment } from '../src/content-fragments.js';
import { competencyIdOf } from '../src/competency-identity.js';
import { questionIsRight } from '../src/course-questions.js';
import { authorFragment, authorLesson, authorModule, composeCourse, type Course } from '../src/emergent-content.js';
import { EMERGENT_FOLD_LIMITS, foldEmergentCourse } from '../src/emergent-fold.js';

const author = { id: 'did:web:author.example', kind: 'human' } as Parameters<typeof authorFragment>[0]['authoredBy'];
const point = 'refund authority thresholds';
const told = authorFragment({ modality: 'concept', competencyPoint: point, body: 'Agents refund up to $250.', level: 'foundational', authoredBy: author });
const shown = authorFragment({ modality: 'worked-example', competencyPoint: point, body: 'A $600 request goes to the team lead.', level: 'working', authoredBy: author, suitsDisposition: 'prefers-worked-examples' });
const check = authorFragment({ modality: 'assessment-item', competencyPoint: point, body: 'Who approves a $600 refund? ::: a team lead — Leads approve above $250.', level: 'working', authoredBy: author });
const lesson = authorLesson({ title: 'Who approves', competency: point, audience: 'human' as never, authoredBy: author, positions: [
  { competencyPoint: point, fragments: [told, shown] },
  { competencyPoint: point, fragments: [check] },
] });
const module = authorModule({ title: 'Refunds', competency: 'resolving refund disputes within policy', authoredBy: author, positions: [{ competencyPoint: point, lessons: [lesson] }] });
const course: Course = composeCourse({ title: 'Refund disputes', competency: 'resolving refund disputes within policy on first contact', audience: 'human' as never, authoredBy: author, positions: [{ competencyPoint: 'resolving refund disputes within policy', modules: [module] }] });
const blindFor = (id: string): string => createHash('sha256').update(`a bridge secret\n${id}`).digest('hex');
const folded = foldEmergentCourse(course, { blindFor });
const byIri = new Map<string, Fragment | Composition>(folded.items.map(x => [x['@id'], x]));
const at = <T extends Fragment | Composition>(olderId: string): T => byIri.get(folded.mapped[olderId]!) as T;

describe('an emergent course folds into compositions', () => {
  it('keeps every syntagm and paradigm in the author\'s order, a composition at each level', () => {
    const root = folded.root;
    expect(root.title).toBe('Refund disputes');
    expect(root.positions.map(p => p.paradigm)).toEqual([[folded.mapped[module.id]]]);
    const m = at<Composition>(module.id);
    expect(m.positions.map(p => p.paradigm)).toEqual([[folded.mapped[lesson.id]]]);
    const l = at<Composition>(lesson.id);
    expect(l.positions.map(p => p.paradigm)).toEqual([[folded.mapped[told.id], folded.mapped[shown.id]], [folded.mapped[check.id]]]);
    expect(folded.items.at(-1)).toBe(root);
    for (const x of folded.items) expect('positions' in x ? compositionIsIntact(x as Composition) : fragmentIsIntact(x as Fragment), x['@id']).toBe(true);
    expect(Object.keys(folded.mapped).sort()).toEqual([told.id, shown.id, check.id, lesson.id, module.id, course.id].sort());
  });

  it('names a competency by the very text its author wrote', () => {
    expect(competencyIdOf(folded.root.competency)).toBe('resolving refund disputes within policy on first contact');
    expect(competencyIdOf(at<Composition>(lesson.id).positions[0]!.competency)).toBe(point);
    expect(at<Fragment>(told.id).competencies.map(c => competencyIdOf(c))).toEqual([point]);
  });

  it('carries each fragment\'s form, level and suitability, and grades its checks on the bridge', () => {
    expect(at<Fragment>(told.id)).toMatchObject({ kind: 'concept', level: 'foundational', body: 'Agents refund up to $250.' });
    expect(at<Fragment>(shown.id)).toMatchObject({ kind: 'worked-example', suits: ['prefers-worked-examples'] });
    const graded = at<Fragment>(check.id);
    expect(graded).toMatchObject({ kind: 'assessment-item', body: 'Who approves a $600 refund?' });
    const q = graded.questions![0]!;
    for (const [reply, right] of [['a team lead', true], ['Team lead', true], ['a manager', false]] as const) expect(questionIsRight(reply, q), reply).toBe(right);
    expect(q.explanation).toBe('Leads approve above $250.');
    expect(JSON.stringify(publicFragment(graded))).not.toMatch(/answerHash|acceptHashes|salt|blind|Leads approve/);
  });

  it('folds the same course to the same IRIs with the same blinding', () => {
    expect(foldEmergentCourse(course, { blindFor }).root['@id']).toBe(folded.root['@id']);
    expect(foldEmergentCourse(course).mapped[told.id]).toBe(folded.mapped[told.id]);   // teaching carries no secret
  });

  it('resolves and plays like any composition', () => {
    const learner = { id: 'did:web:learner.example', kind: 'agent' as const };
    const r = resolveComposition({ composition: folded.root, learner, lookup: iri => byIri.get(iri) });
    // A learner with no record is pitched at foundational, so the foundational alternative is chosen.
    expect(r.steps.map(s => s.fragment['@id'])).toEqual([folded.mapped[told.id], folded.mapped[check.id]]);
    const ctx = { actor: { objectType: 'Agent', account: { homePage: 'did:web:bridge.example', name: learner.id } }, now: new Date().toISOString(), newId: () => crypto.randomUUID() };
    const play = startPlay(r, folded.root.title, learner, { session: 's', registration: 'r' }, ctx.now)!;
    advancePlay(play, undefined, ctx);
    expect(advancePlay(play, ['team lead'], ctx)).toMatchObject({ ok: true, graded: { correct: 1, total: 1 } });
  });

  it('refuses what is not an emergent course, saying where', () => {
    expect(() => foldEmergentCourse('nope')).toThrow(ContentError);
    expect(() => foldEmergentCourse({ ...course, syntagm: [{ competencyPoint: 'x', paradigm: [{ title: 'M' }] }] })).toThrow(/module 1 has no syntagm|position 1, alternative 1 has no syntagm/);
    const unwritten = authorFragment({ modality: 'assessment-item', competencyPoint: point, body: 'Who approves?', level: 'working', authoredBy: author });
    const broken = composeCourse({ ...course, audience: 'human' as never, authoredBy: author, title: 'B', competency: 'c', positions: [{ competencyPoint: 'c', modules: [authorModule({ title: 'M', competency: 'c', authoredBy: author, positions: [{ competencyPoint: 'c', lessons: [authorLesson({ title: 'L', competency: 'c', audience: 'human' as never, authoredBy: author, positions: [{ competencyPoint: point, fragments: [unwritten] }] })] }] })] }] });
    expect(() => foldEmergentCourse(broken)).toThrow(/alternative 1: an assessment is written "question ::: answer"/);
    expect(() => foldEmergentCourse({ ...course, competency: '  ' })).toThrow(/the course: competency must be a non-empty string/);
  });

  it('makes no more than its limits, however large the course', () => {
    const many = (n: number, offset: number) => Array.from({ length: n }, (_, i) => authorFragment({ modality: 'concept', competencyPoint: point, body: `Explanation ${offset + i}.`, level: 'working', authoredBy: author }));
    const wide = (offset: number) => authorLesson({ title: `L${offset}`, competency: point, audience: 'human' as never, authoredBy: author,
      positions: Array.from({ length: 100 }, (_, i) => ({ competencyPoint: point, fragments: many(11, offset + i * 11) })) });
    const big = composeCourse({ title: 'Big', competency: point, audience: 'human' as never, authoredBy: author, positions: [{ competencyPoint: point,
      modules: [authorModule({ title: 'M', competency: point, authoredBy: author, positions: [{ competencyPoint: point, lessons: [wide(0), wide(100_000)] }] })] }] });
    expect(() => foldEmergentCourse(big)).toThrow(`a fold makes at most ${EMERGENT_FOLD_LIMITS.fragments} fragments`);
  });
});

describe('the bridge folds an emergent course for whoever sends it', () => {
  it('takes it in the fold route, blinded under the bridge\'s secret and kept on the caller\'s pod', () => {
    const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
    const r = src.slice(src.indexOf("app.post('/agent/content/fold-course'"), src.indexOf('\n});', src.indexOf("app.post('/agent/content/fold-course'")));
    expect(r).toMatch(/foldEmergentCourse\(p\.course, \{\n\s+blindFor: fragmentId => createHmac\('sha256', courseFoldSecret\)\.update\(`emergent-fold\\n\$\{fragmentId\}`\)/);
    expect(r).toMatch(/const keptEmergent = await keepContentBundle\(emergent\.root, emergent\.items, auth\.callerDid, p\.subject_pod_url\);/);
    expect(r.indexOf('!courseFoldSecret')).toBeLessThan(r.indexOf('foldEmergentCourse('));
  });
});
