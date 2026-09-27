/**
 * Serving composable content: the public form, the store, admissions, and the bridge's routes.
 *
 * A fragment's IRI is the hash of its public form with a commitment to each stored question, so
 * it can be served to anyone without a salt or verifier and still be checked against its IRI.
 * The store keeps nothing that does not hash to its IRI, whoever supplied it. The routes author,
 * dereference and resolve; server.ts cannot be imported (it listens at module scope), so its
 * wiring is asserted over its source, as the other bridge tests do.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ContentError, contentRefOf, fragmentForLearner, fragmentFrom, fragmentIsIntact, publicFragment, publicFragmentIsIntact,
  questionCommitment,
} from '../src/content-fragments.js';
import { admissionFrom, compositionFrom } from '../src/compositions.js';
import { ContentStore, LOCATIONS_PER_ITEM, mergeLocations, type ContentItem } from '../src/content-store.js';
import { authorQuestion, questionIsRight } from '../src/course-questions.js';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@interego/core';
import { lookupTerm } from '../src/foxxi-vocab.js';

const quiz = fragmentFrom({
  kind: 'assessment-item', competencies: ['refund-authority'], title: 'Check', body: 'Who approves what?',
  questions: [
    { question: 'Who approves $600?', options: ['Agent', 'Team lead'], answer: 'B', explanation: 'Leads approve above $250.' },
    { question: 'Account code?', type: 'fill-in', answer: 'RF-12' },
  ],
});
const mirror = (iri: string): string => iri.replace(/^https:\/\/[^/]+/, 'https://mirror.example');

describe('a fragment can be served in public without its verifiers, and still be checked', () => {
  it('drops salts, verifiers and explanations, and keeps a commitment to each stored question', () => {
    const p = publicFragment(quiz);
    const text = JSON.stringify(p);
    for (const secret of ['answerHash', 'acceptHashes', 'salt', 'explanation', 'Leads approve']) expect(text).not.toContain(secret);
    expect(p.questions!.map(q => q.commitment)).toEqual(quiz.questions!.map(q => questionCommitment(q, quiz.blind)));
    expect(text).not.toContain(quiz.blind!);
    expect('blind' in p).toBe(false);
    expect(p.questions!.map(q => q.graded)).toEqual([true, true]);
    expect(p['@id']).toBe(quiz['@id']);
  });

  it('is no oracle for its answers: the stored form for a guessed answer cannot be rebuilt from it', () => {
    // Everything public about a true/false question, and what an attacker can derive from it.
    const tf = fragmentFrom({ kind: 'assessment-item', competencies: ['refunds'], body: 'Check.', questions: [{ question: 'Refunds need a reason.', answer: true }] });
    const p = publicFragment(tf);
    const publicSeed = (blind?: string): string => createHash('sha256')
      .update(canonicalJson({ kind: 'assessment-item', level: 'working', competencies: ['refunds'], body: 'Check.', ...(blind ? { blind } : {}) })).digest('hex');
    for (const answer of [true, false]) {
      const guess = authorQuestion({ question: 'Refunds need a reason.', answer }, `${publicSeed()}\n0`);
      expect(questionCommitment(guess)).not.toBe(p.questions![0]!.commitment);
    }
    // The same rebuilding with the blinding value, which only the stored form holds, does match the right
    // answer: so the negative result above is the value doing its work, not a wrong reconstruction.
    const right = authorQuestion({ question: 'Refunds need a reason.', answer: true }, `${publicSeed(tf.blind)}\n0`);
    expect(questionCommitment(right, tf.blind)).toBe(p.questions![0]!.commitment);
    // A question sent already in stored form keeps its own salt, which may come from a seed anyone can
    // work out (a course's, say): then the whole stored question can be rebuilt exactly. The commitment
    // still takes the blinding value, so even then it is no oracle.
    const exposed = authorQuestion({ question: 'Refunds need a reason.', answer: true }, 'a seed anyone can work out');
    const reused = fragmentFrom({ kind: 'assessment-item', competencies: ['refunds'], body: 'Again.', questions: [exposed] });
    const rebuilt = authorQuestion({ question: 'Refunds need a reason.', answer: true }, 'a seed anyone can work out');
    expect(rebuilt).toEqual(exposed);
    expect(questionCommitment(rebuilt)).not.toBe(publicFragment(reused).questions![0]!.commitment);
    // A fragment with nothing graded needs no value, and stays the same fragment wherever it is authored.
    const survey = { kind: 'reflection', competencies: ['refunds'], body: 'Think back.', questions: [{ question: 'How sure were you?', type: 'likert' }] };
    expect(fragmentFrom(survey).blind).toBeUndefined();
    expect(fragmentFrom(survey)['@id']).toBe(fragmentFrom(survey)['@id']);
    expect(() => fragmentFrom({ ...tf, blind: 'not-hex' })).toThrow(/blind is the 64 hex characters/);
  });

  it('checks the public form and the stored form against the same IRI, and neither survives a change', () => {
    const p = publicFragment(quiz);
    expect(publicFragmentIsIntact(p)).toBe(true);
    expect(publicFragmentIsIntact(JSON.parse(JSON.stringify(p)))).toBe(true);
    expect(publicFragmentIsIntact({ ...p, '@id': mirror(p['@id']), competencies: p.competencies.map(mirror) })).toBe(true);
    expect(publicFragmentIsIntact({ ...p, body: 'Anyone approves anything.' })).toBe(false);
    expect(publicFragmentIsIntact({ ...p, questions: [{ ...p.questions![0]!, question: 'Who approves $6?' }, p.questions![1]!] })).toBe(false);
    expect(publicFragmentIsIntact({ ...p, questions: [{ ...p.questions![0]!, commitment: '0'.repeat(64) }, p.questions![1]!] })).toBe(false);
    // The stored form is bound through the commitments: a changed verifier, salt or explanation breaks it.
    expect(fragmentIsIntact(quiz)).toBe(true);
    const q0 = quiz.questions![0]!;
    for (const changed of [{ ...q0, answerHash: '0'.repeat(64) }, { ...q0, explanation: 'Anyone can.' }, { ...q0, input: { ...q0.input!, salt: 'f'.repeat(16) } }]) {
      expect(fragmentIsIntact({ ...quiz, questions: [changed, quiz.questions![1]!] })).toBe(false);
    }
  });

  it('gives a learner the public form, numbered and rendered, and grades against the stored form', () => {
    const view = fragmentForLearner(quiz) as { questions: Array<{ index: number; commitment: string }>; bodyHtml: string };
    expect(view.questions.map(q => q.index)).toEqual([0, 1]);
    expect(view.bodyHtml).toBe('<p>Who approves what?</p>');
    expect(JSON.stringify(view)).not.toMatch(/answerHash|salt/);
    expect(questionIsRight('B', quiz.questions![0]!)).toBe(true);
    expect(questionIsRight('rf-12', quiz.questions![1]!)).toBe(true);
  });
});

const lesson = fragmentFrom({ kind: 'concept', competencies: ['refund-authority'], body: 'Agents refund up to $250.' });
const course = compositionFrom({ title: 'Refunds', competency: 'refund-authority', positions: [{ competency: 'refund-authority', paradigm: [lesson['@id'], quiz['@id']] }] });

describe('the store keeps nothing that does not hash to its IRI', () => {
  it('refuses changed content, and finds kept content by its IRI on any authority', () => {
    const store = new ContentStore();
    expect(() => store.put({ ...lesson, body: 'Refund anything.' })).toThrow(ContentError);
    store.put(lesson);
    expect(store.get(lesson['@id'])).toBe(lesson);
    expect(store.get(mirror(lesson['@id']))).toBe(lesson);
    expect(store.get(course['@id'])).toBeUndefined();
  });

  it('lets the least recently kept go past its cap', () => {
    const store = new ContentStore(2);
    const [a, b, c] = ['a', 'b', 'c'].map(t => fragmentFrom({ kind: 'reference', competencies: ['x'], body: t }));
    store.put(a!); store.put(b!); store.put(a!); store.put(c!);
    expect([store.get(a!['@id']), store.get(b!['@id']), store.get(c!['@id'])]).toEqual([a, undefined, c]);
  });

  it('reads through to durable storage, and keeps only what hashes to the IRI asked for', async () => {
    const asked: string[] = [];
    const durable = new Map<string, ContentItem>([[lesson['@id'], lesson], [quiz['@id'], { ...quiz, body: 'Changed.' }], [course['@id'], lesson]]);
    const store = new ContentStore(100, { load: async ({ iri }) => { asked.push(iri); return durable.get(iri); } });
    expect(await store.fetch(lesson['@id'])).toBe(lesson);
    expect(await store.fetch(lesson['@id'])).toBe(lesson);
    expect(asked).toEqual([lesson['@id']]);                     // the second came from the cache
    expect(await store.fetch(quiz['@id'])).toBeUndefined();     // served changed
    expect(await store.fetch(course['@id'])).toBeUndefined();   // served something else
    expect(store.get(quiz['@id'])).toBeUndefined();
  });

  it('gathers everything a composition reaches before it is resolved, and says what it could not find', async () => {
    const missingFragment = lesson['@id'].replace(/[0-9a-f]{64}$/, 'a'.repeat(64));
    const module = compositionFrom({ title: 'Module', competency: 'x', positions: [{ competency: 'x', paradigm: [lesson['@id'], missingFragment] }] });
    const top = compositionFrom({ title: 'Top', competency: 'x', positions: [{ competency: 'x', paradigm: [module['@id'], quiz['@id']] }] });
    const durable = new Map<string, ContentItem>([[lesson['@id'], lesson], [quiz['@id'], quiz], [module['@id'], module]]);
    const store = new ContentStore(100, { load: async ({ iri }) => durable.get(iri) });
    expect(await store.gather(top)).toEqual({ missing: [missingFragment] });
    expect(store.get(lesson['@id'])).toBe(lesson);
    await expect(store.gather(top, 2)).rejects.toThrow(/"Top" reaches more than 2 pieces of content/);
  });
});

describe('the index of where content lives', () => {
  it('keeps several authors\' pods per item, earliest first, and nothing it cannot read as a content key', () => {
    const key = contentRefOf(lesson['@id'])!;
    const k = `${key.type}:${key.hash}`;
    // As the durable index arrives from a pod: JSON, where "__proto__" is an ordinary key.
    // The index keeps the pod each author wrote to; the earlier form, a bare DID, is read as one with no pod.
    const durable: unknown = JSON.parse(`{"__proto__":["did:web:x"],"fragment:nothex":["did:web:y"],"${k}":["did:web:first.example"]}`);
    expect(Object.keys(durable as object)).toContain('__proto__');
    const at = (n: string): { did: string; pod: string } => ({ did: `did:web:${n}.example`, pod: `https://pods.example/${n}/` });
    const merged = mergeLocations(durable, new Map([[k, [at('second'), at('second'), { did: 'did:web:first.example', pod: '' }, at('c'), at('d'), at('e'), at('f')]]]));
    expect([...merged.keys()]).toEqual([k]);
    expect(merged.get(k)).toEqual([{ did: 'did:web:first.example', pod: '' }, at('second'), at('c'), at('d'), at('e')]);
    expect(merged.get(k)).toHaveLength(LOCATIONS_PER_ITEM);
    // A pod that is not an http(s) URL is not a location.
    expect(mergeLocations({ [k]: [{ did: 'did:web:a', pod: 'file:///etc/passwd' }, { did: 'did:web:b', pod: 'javascript:x' }] }, {}).size).toBe(0);
    expect(mergeLocations(null, 'nonsense').size).toBe(0);
  });
});

describe('an admission a caller sends is checked', () => {
  it('takes fragment kinds and a reason, and refuses anything else', () => {
    expect(admissionFrom({ kinds: ['probe', 'reflection', 'probe'], because: 'the plan for this Emergent work selected probe and coaching' }))
      .toEqual({ kinds: ['probe', 'reflection'], because: 'the plan for this Emergent work selected probe and coaching' });
    expect(admissionFrom({ kinds: [], because: 'fix the tools first' }).kinds).toEqual([]);
    expect(() => admissionFrom({ kinds: ['slideshow'], because: 'x' })).toThrow(/admission.kinds\[0\] is not a fragment kind/);
    expect(() => admissionFrom({ kinds: ['probe'] })).toThrow(/admission.because/);
    expect(() => admissionFrom({ kinds: ['probe'], because: 'x'.repeat(501) })).toThrow(/at most 500/);
    expect(() => admissionFrom(['probe'])).toThrow(/an admission is/);
  });
});

describe('the bridge authors, dereferences and resolves content through these', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  const route = (from: string): string => src.slice(src.indexOf(from), src.indexOf('\n});', src.indexOf(from)));

  it('authors a fragment and a composition as the signed caller, keeping them where their hash can be checked', () => {
    const fragment = route("app.post('/agent/content/fragment'");
    expect(fragment).toMatch(/verifyDelegatedCaller\(req\.body\)/);
    expect(fragment).toMatch(/fragmentFrom\(auth\.payload\.fragment\)/);
    expect(fragment).toMatch(/keepAuthoredContent\(fragment, auth\.callerDid/);
    expect(fragment).toMatch(/fragment: publicFragment\(fragment\)/);
    const composition = route("app.post('/agent/content/composition'");
    expect(composition).toMatch(/compositionFrom\(auth\.payload\.composition\)/);
    expect(composition).toMatch(/contentStore\.fetch\(iri\)/);
    expect(composition).toMatch(/res\.status\(422\)/);
    const keep = route('async function keepAuthoredContent');
    expect(keep).toMatch(/contentStore\.put\(item\)/);
    expect(keep).toMatch(/composeIntoSharedLattice\(/);
    expect(keep).toMatch(/verbIri: AUTHORED_VERB/);
    expect(src).toMatch(/sameContent\(String\(\(c as \{ '@id'\?: unknown \}\)\['@id'\] \?\? ''\), iri\)/);
    // Every pod that holds an item is tried, the one it was written to and only on this tenant's server,
    // so one author withdrawing it, or writing to a twin pod, does not lose it.
    expect(src).toMatch(/for \(const \{ did, pod: written \} of contentLocations\.get\(key\) \?\? \[\]\) \{\n\s+const pod = written \|\| resolveSubjectPodUrl\(did\);/);
    // This tenant's store under either spelling: a relay-signed author's pod may be recorded by the
    // store's internal address, and a raw-origin comparison would lose it after a restart.
    expect(src).toMatch(/if \(!tenantPodUrl \|\| !sameStore\(pod, tenantPodUrl\)\) continue;/);
    expect(src).not.toMatch(/podOrigin !== tenantOrigin\) continue;/);
    expect(route('function recordContentLocation')).toMatch(/held\.length >= LOCATIONS_PER_ITEM/);
    // The index is written one write at a time, a failed write tried again on its own, and an index
    // that cannot be read now is not written over (src/state-writer.ts).
    expect(route('function recordContentLocation')).toMatch(/if \(CONTENT_LOCATIONS_RESOURCE\) contentLocationsWriter\.request\(\);/);
    const index = route('const contentLocationsWriter = stateWriter(');
    expect(index).toMatch(/if \(!r\.ok && r\.status !== 404\) throw new Error/);
    expect(index.indexOf('mergeLocations(durable, contentLocations)')).toBeGreaterThan(index.indexOf('r.status !== 404'));
    expect(index).toMatch(/if \(!w\.ok\) throw new Error/);
    // Kept only once the pod holds it: the lattice write comes first and must report persisted.
    const keepFirst = route('async function keepAuthoredContent');
    expect(keepFirst.indexOf('composeIntoSharedLattice(')).toBeLessThan(keepFirst.indexOf('contentStore.put(item)'));
    expect(keepFirst).toMatch(/if \(!sharedLattice\?\.persisted\) \{/);
    expect(keepFirst).toMatch(/recordContentLocation\(`\$\{ref\.type\}:\$\{ref\.hash\}`, authorDid, authorPod\)/);
    for (const path of ['/agent/content/fragment', '/agent/content/composition']) {
      expect(route(`app.post('${path}'`)).toMatch(/if \(!kept\.ok\) \{ res\.status\(503\)/);
    }
    // Every content route takes the per-IP limit before anything else.
    for (const path of ['/agent/content/fragment', '/agent/content/composition', '/agent/content/resolve']) {
      const r = route(`app.post('${path}'`);
      expect(r.indexOf('contentRateLimited(req, res)'), path).toBeGreaterThan(0);
      expect(r.indexOf('contentRateLimited(req, res)'), path).toBeLessThan(r.indexOf('verifyDelegatedCaller'));
    }
  });

  it('serves a fragment only in its public form, and resolves for the caller from their own record', () => {
    const deref = route("app.get('/ns/foxxi/fragment/:hash'");
    expect(deref).toMatch(/publicFragment\(item\)/);
    expect(deref).not.toMatch(/JSON\.stringify\(item/);
    // Resolve goes through the one path launch shares, which reads the caller's own record.
    const resolve = route("app.post('/agent/content/resolve'");
    expect(resolve).toMatch(/resolveForCaller\(auth\.callerDid, auth\.signer, auth\.payload\)/);
    expect(resolve).toMatch(/fragment: fragmentForLearner\(s\.fragment\)/);
    const shared = route('async function resolveForCaller');
    expect(shared).toMatch(/contentStore\.gather\(root\)/);
    expect(shared).toMatch(/learnerCompetencies\(callerDid, kind\)/);
    expect(shared).toMatch(/resolveComposition\(\{/);
    expect(shared).toMatch(/admissionFrom\(p\.admission\)/);
  });

  it('declares the activity types and the type its statements and lattice use', () => {
    for (const term of ['activities/fragment', 'activities/composition', 'Composition']) expect(lookupTerm(term), term).toBeTruthy();
    expect(contentRefOf(course['@id'])?.type).toBe('composition');
  });
});

