/**
 * An authored course folded into composable content: each section's teaching a concept fragment,
 * its questions a check in their stored form, a section with both a composition of its own, and
 * the course a composition of its sections in order. What it makes resolves and plays like any
 * composition, and grades exactly as the course did.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { advancePlay, startPlay } from '../src/composition-play.js';
import { compositionIsIntact, resolveComposition, type Composition } from '../src/compositions.js';
import { ContentError, fragmentIri, fragmentIsIntact, publicFragment, type Fragment } from '../src/content-fragments.js';
import { bundledItem } from '../src/content-store.js';
import { competencyIri } from '../src/competency-identity.js';
import { authorQuestion, questionIsRight } from '../src/course-questions.js';
import { foldCourse, type FoldableCourse } from '../src/course-fold.js';
import { lookupTerm } from '../src/foxxi-vocab.js';

const courseId = 'refunds-101';
const asAuthored = (sco: string, qs: unknown[]) => qs.map((q, i) => authorQuestion(q, `${courseId}\n${sco}\n${i}`));
const course: FoldableCourse = {
  courseId, title: 'Refunds', scos: [
    { id: 'who', title: 'Who approves', body: 'Agents refund up to $250. Team leads approve above that.', assessment: asAuthored('who', [
      { question: 'Who approves $600?', options: ['Agent', 'Team lead'], answer: 'B', explanation: 'Leads approve above $250.' },
      { question: 'An agent may refund up to how many dollars?', answer: '250' },
    ]) },
    { id: 'why', title: 'Why the limit', body: 'Limits keep refunds auditable.' },
    { id: 'empty', title: 'Placeholder', body: '   ' },
  ],
};
const competency = competencyIri('refund-authority');
const blindFor = (id: string): string => createHash('sha256').update(`a bridge secret\n${id}`).digest('hex');
const folded = foldCourse(course, { competency, blindFor });
const byId = new Map<string, Fragment | Composition>(folded.items.map(x => [x['@id'], x]));
const item = <T extends Fragment | Composition>(iri: string | undefined): T => byId.get(iri!) as T;
const [who, why, empty] = folded.sections;

describe('a course folds into teaching, checks and compositions, in its order', () => {
  it('makes a section with teaching and questions a composition of its own, and places a single part directly', () => {
    expect(who).toMatchObject({ id: 'who', title: 'Who approves', competency, at: who!.lesson });
    expect(item<Fragment>(who!.concept)).toMatchObject({ kind: 'concept', title: 'Who approves', body: course.scos[0]!.body, competencies: [competency] });
    expect(item<Fragment>(who!.check)).toMatchObject({ kind: 'assessment-item', body: '## Who approves' });
    expect(item<Composition>(who!.lesson).positions.map(p => p.paradigm)).toEqual([[who!.concept], [who!.check]]);
    expect(why).toMatchObject({ at: why!.concept });
    expect(why!.check).toBeUndefined();
    expect(empty!.at).toBeUndefined();
    expect(folded.root).toMatchObject({ title: 'Refunds', competency });
    expect(folded.root.positions.map(p => p.paradigm)).toEqual([[who!.lesson], [why!.concept]]);
  });

  it('makes a section whose questions are all ungraded a reflection, placed directly when it has no teaching', () => {
    const f = foldCourse({ courseId, title: 'T', scos: [
      { id: 'feel', title: 'How it went', body: '', assessment: asAuthored('feel', [{ question: 'How sure are you now?', type: 'likert' }]) },
    ] }, { competency });
    const [feel] = f.sections;
    expect((f.items.find(x => x['@id'] === feel!.check) as Fragment).kind).toBe('reflection');
    expect(feel).toMatchObject({ at: feel!.check });
    expect(feel!.concept).toBeUndefined();
    expect(f.root.positions.map(p => p.paradigm)).toEqual([[feel!.check]]);
  });

  it('makes every item once, each what its IRI says, with the course last', () => {
    expect(folded.items.at(-1)).toBe(folded.root);
    expect(new Set(folded.items.map(x => x['@id'])).size).toBe(folded.items.length);
    expect(folded.items).toHaveLength(5);   // two concepts, a check, a lesson, the course
    for (const x of folded.items) expect('positions' in x ? compositionIsIntact(x as Composition) : fragmentIsIntact(x as Fragment), x['@id']).toBe(true);
  });

  it('keeps the questions as they were authored, so they grade the same, and serves none of their verifiers', () => {
    const check = item<Fragment>(who!.check);
    expect(check.questions).toEqual(course.scos[0]!.assessment);
    for (const reply of ['B', 'A', 'Team lead']) expect(questionIsRight(reply, check.questions![0]!)).toBe(questionIsRight(reply, course.scos[0]!.assessment![0]!));
    expect(questionIsRight('B', check.questions![0]!)).toBe(true);
    expect(questionIsRight('250', check.questions![1]!)).toBe(true);
    expect(JSON.stringify(publicFragment(check))).not.toMatch(/answerHash|acceptHashes|salt|blind|Leads approve/);
  });

  it('folds the same course to the same IRIs with the same blinding, and to new checks without it', () => {
    expect(foldCourse(course, { competency, blindFor }).root['@id']).toBe(folded.root['@id']);
    const unblinded = [foldCourse(course, { competency }), foldCourse(course, { competency })];
    expect(unblinded[0]!.sections[0]!.concept).toBe(who!.concept);   // teaching carries no secret
    expect(unblinded[0]!.sections[0]!.check).not.toBe(unblinded[1]!.sections[0]!.check);
    expect(unblinded[0]!.sections[0]!.check).not.toBe(who!.check);
  });

  it('names the competency for the course, or for a section where one is given', () => {
    const f = foldCourse(course, { competency, blindFor, sectionCompetencies: { why: 'refund-policy' } });
    const whySection = f.sections[1]!;
    expect(whySection.competency).toBe(competencyIri('refund-policy'));
    expect((f.items.find(x => x['@id'] === whySection.concept) as Fragment).competencies).toEqual([competencyIri('refund-policy')]);
    expect(f.root.positions.map(p => p.competency)).toEqual([competency, competencyIri('refund-policy')]);
    expect(f.root.competency).toBe(competency);
    // A section id that names something every object inherits is still only a section id.
    const odd = foldCourse({ courseId, title: 'T', scos: [{ id: 'constructor', title: 'C', body: 'Body.' }, { id: '__proto__', title: 'P', body: 'Body two.' }] },
      { competency, sectionCompetencies: JSON.parse('{"__proto__": "refund-policy"}') });
    expect(odd.sections.map(s => s.competency)).toEqual([competency, competencyIri('refund-policy')]);
  });

  it('shortens a title too long for a fragment, and refuses what it cannot fold, saying where', () => {
    const long = foldCourse({ courseId, title: 'T', scos: [{ id: 's', title: `${'word '.repeat(60)}end`, body: 'Body.' }] }, { competency });
    const title = long.sections[0]!.title;
    expect(title.length).toBeLessThanOrEqual(200);
    expect(title.endsWith('…')).toBe(true);
    expect(() => foldCourse({ courseId, title: 'T', scos: [] }, { competency })).toThrow(ContentError);
    expect(() => foldCourse({ courseId, title: 'T', scos: Array.from({ length: 101 }, (_, i) => ({ id: `s${i}`, title: 's', body: 'b' })) }, { competency })).toThrow(/at most 100 positions/);
    expect(() => foldCourse({ courseId, title: 'T', scos: [{ id: 'e', title: 'E', body: '' }] }, { competency })).toThrow(/no section has teaching or questions/);
    expect(() => foldCourse(course, { competency, level: 'expert' as never })).toThrow(/section 1 \(who\): level must be one of/);
  });
});

describe('a folded course is a composition like any other', () => {
  it('resolves in the course\'s order, plays, and grades its check with the course\'s answers', () => {
    const learner = { id: 'did:web:learner.example', kind: 'agent' as const };
    const r = resolveComposition({ composition: folded.root, learner, lookup: iri => byId.get(iri) });
    expect(r.steps.map(s => s.fragment['@id'])).toEqual([who!.concept, who!.check, why!.concept]);
    const ctx = { actor: { objectType: 'Agent', account: { homePage: 'did:web:bridge.example', name: learner.id } }, now: '2026-09-27T12:00:00.000Z', newId: () => crypto.randomUUID() };
    const play = startPlay(r, folded.root.title, learner, { session: 's', registration: 'r' }, ctx.now)!;
    expect(advancePlay(play, undefined, ctx)).toMatchObject({ ok: true, outcomes: [] });
    const checked = advancePlay(play, ['B', '250'], ctx);
    if (!checked.ok) throw new Error(checked.error);
    expect(checked.graded).toMatchObject({ correct: 2, total: 2 });
    // The teaching is credited with the check that follows it.
    expect(checked.outcomes.map(o => [o.fragment, o.success])).toEqual([[who!.check, true], [who!.concept, true]]);
  });

  it('is found inside the bundle it is kept in, by its IRI on any authority, and nothing else is', () => {
    const bundle = { '@id': folded.root['@id'], items: folded.items };
    expect(bundledItem(bundle, who!.check!)).toBe(item(who!.check));
    const hash = who!.check!.split('/').at(-1)!;
    expect(bundledItem(bundle, `https://elsewhere.example/ns/foxxi/fragment/${hash}`)).toBe(item(who!.check));
    expect(bundledItem(bundle, fragmentIri('0'.repeat(64)))).toBeUndefined();
    for (const notABundle of [null, undefined, {}, { items: 'x' }, folded.root]) expect(bundledItem(notABundle, who!.check!)).toBeUndefined();
  });
});

describe('the bridge folds a course for its author, and keeps it as one bundle', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  const route = (from: string): string => src.slice(src.indexOf(from), src.indexOf('\n});', src.indexOf(from)));
  const fn = (from: string): string => src.slice(src.indexOf(from), src.indexOf('\n}\n', src.indexOf(from)));

  it('folds only for the course\'s author, and only after the caller is verified and within the content budget', () => {
    const r = route("app.post('/agent/content/fold-course'");
    expect(r.indexOf('contentRateLimited(req, res)')).toBeGreaterThan(0);
    expect(r.indexOf('contentRateLimited(req, res)')).toBeLessThan(r.indexOf('verifyDelegatedCaller(req.body)'));
    expect(r).toMatch(/const course = await resolveCourseForRead\(courseId\);/);
    expect(r).toMatch(/if \(course\.authoredBy !== auth\.callerDid\) \{ res\.status\(403\)/);
    expect(r.indexOf('course.authoredBy !== auth.callerDid')).toBeLessThan(r.indexOf('foldCourse('));
    // Blinded from the grading secret: the same course folds to the same IRIs, and no learner can rebuild a check.
    expect(r).toMatch(/blindFor: sectionId => \(gradedKey \? createHmac\('sha256', gradedKey\)\.update\(`course-fold\\n\$\{courseIri\(courseId\)\}\\n\$\{sectionId\}`\)/);
    expect(r).toMatch(/const kept = await keepContentBundle\(folded\.root, folded\.items, auth\.callerDid, p\.subject_pod_url\);/);
    expect(r).toMatch(/if \(!kept\.ok\) \{ res\.status\(503\)/);
  });

  it('writes the bundle to the author\'s pod once, and caches and indexes each item only once it is kept', () => {
    const keep = fn('async function keepContentBundle');
    expect(keep.match(/composeIntoSharedLattice\(/g)).toHaveLength(1);
    expect(keep).toMatch(/contentType: CONTENT_TYPES\.bundle/);
    expect(keep).toMatch(/if \(!sharedLattice\?\.persisted\) \{/);
    expect(keep.indexOf('sharedLattice?.persisted')).toBeLessThan(keep.indexOf('contentStore.put(item)'));
    expect(keep).toMatch(/for \(const item of items\) \{\n\s+contentStore\.put\(item\);\n\s+const ref = contentRefOf\(item\['@id'\]\)!;\n\s+recordContentLocation\(/);
    expect(keep.match(/emitAgentActivity\(/g)).toHaveLength(1);
    expect(src).toMatch(/bundle: 'foxxi:ContentBundle'/);
    expect(lookupTerm('ContentBundle')).toBeTruthy();
  });

  it('reads an item back from inside a bundle on a pod it was written to, checked like anything else', () => {
    expect(src).toMatch(/CONTENT_TYPES\.bundle,\n\s+c => bundledItem\(c, iri\) !== undefined\)\.catch\(\(\) => null\);\n\s+const inside = bundledItem\(bundle, iri\);\n\s+if \(inside\) return inside;/);
  });
});
