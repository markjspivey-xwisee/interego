/**
 * "Ask your course": an answer assembled from the course's sections and the I2IDL glossary,
 * decorated with I2IDL-X. Every part says whose it is; a definition whose sources do not allow
 * commercial reuse is linked, not quoted; an assessment is never read; no model is called.
 */
import { describe, expect, it } from 'vitest';
import { askCourse, plainText } from '../src/course-ask.js';
import { conceptMatcher, parseI2idlGlossary, parseI2idlxDecorations, type GlossarySources } from '../src/i2idl-glossary.js';
import { glossaryJsonLd, i2idlxGraphs } from './support/i2idl-glossary-fixture.js';

const glossary = parseI2idlGlossary(glossaryJsonLd);
const sources: GlossarySources = { glossary, matcher: conceptMatcher(glossary.concepts), decorations: parseI2idlxDecorations(i2idlxGraphs), loadedAt: 0 };
const course = {
  courseId: 'learning-data', title: 'Learning data basics',
  scos: [
    { id: 'record', title: 'Recording learning', body: '## Where records go\n\nAn **LRS** keeps the xAPI statements that learning activities send it.\n\nEach statement has an actor, a verb and an object.' },
    { id: 'check', title: 'Checking understanding', body: 'Formative assessment happens while learning is still under way, so it can change what comes next.',
      assessment: [{ question: 'Which secret answer is right?', answerHash: 'deadbeef' }] },
    { id: 'design', title: 'Designing with evidence', body: 'Learning engineering asks what the evidence says before a course is built.' },
  ],
};
const href = (id: string) => `https://bridge.example/agent/scorm/course/learning-data/sco-${id}.html`;
const ask = (question: string, s: GlossarySources | null = sources) => askCourse({ course, question, sources: s, href });

describe('an I2IDL term in the question', () => {
  it('quotes I2IDL\'s definition when its sources allow it, in I2IDL\'s own provenance wording, and says where the course covers it', () => {
    const a = ask('What does formative assessment mean?');
    expect(a.grounding).toBe('glossary-and-course');
    expect(a.answer).toBe('Formative assessment is an I2IDL glossary term. I2IDL defines it as “Assessment used during learning to guide what comes next.” (Direct source definition: World Bank). This course covers it in “Checking understanding”.');
    const c = a.concepts[0]!;
    expect(c).toMatchObject({ iri: 'https://id.i2idl.org/concepts/formative-assessment', card: 'https://www.i2idl.org/glossary#formative-assessment', origin: 'I2IDL', definition: 'Assessment used during learning to guide what comes next.' });
    expect(c.provenance).toEqual({ wording: 'Direct source definition', origin: 'I2IDL-X · derived' });
    expect(c.reuse).toMatchObject({ class: 'open', origin: 'I2IDL-X · derived' });
    expect(c.inCourse).toEqual([{ id: 'check', title: 'Checking understanding', href: href('check') }]);
  });

  it('links instead of quoting a definition that rests on a source used with permission or non-commercially', () => {
    const lrs = ask('What is an LRS?').concepts[0]!;
    expect(lrs.definition).toBeUndefined();
    expect(lrs.definitionWithheld).toBe('I2IDL\'s definition rests directly on LeBOK (Used with permission), which does not allow commercial reuse without permission, so it is not quoted here. Read it on I2IDL\'s card.');
    expect(lrs.reuse.class).toBe('permission');
    expect(lrs.sources.map(s => [s.label, s.relation, s.rights])).toEqual([['LeBOK', 'direct', 'Used with permission'], ['Modernizing Learning', 'supporting', 'CC BY 4.0 IGO']]);
    const le = ask('Explain learning engineering');
    expect(le.concepts[0]!.definition).toBeUndefined();
    expect(le.answer).not.toContain('A process for designing learning');
    expect(JSON.stringify(ask('What is an LRS?'))).not.toContain('A store that keeps learning records');
  });

  it('carries I2IDL-X\'s proposals as Hypothetical, from the graph that holds them', () => {
    const x = ask('What is an LRS?').concepts[0]!.i2idlx!;
    expect(x.referent).toMatchObject({ label: 'Application or platform', origin: 'I2IDL-X · proposed', modalStatus: 'Hypothetical', graph: 'https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/i2idlx-referents' });
    expect(x.enactments).toEqual([expect.objectContaining({ action: 'https://relay.interego.xwisee.com/ns/iep/action/foxxi/discover-lrs', role: 'realizes', status: 'proposed', modalStatus: 'Hypothetical' })]);
    expect(ask('What is an LRS?').attribution).toEqual({
      glossary: { title: 'I2IDL Digital Learning Glossary', release: 'v0.0.86', url: 'https://id.i2idl.org/glossary.jsonld', rights: glossary.rights },
      i2idlx: expect.objectContaining({ note: expect.stringContaining('not affiliated with or endorsed by I2IDL') }),
    });
  });

  it('says so when the course does not use a term the glossary has', () => {
    const a = ask('How does feedback work?');
    expect(a.grounding).toBe('glossary');
    expect(a.answer).toContain('This course does not use the term.');
  });
});

describe('the course\'s own words', () => {
  it('finds the sections a question\'s words appear in, with a snippet from the right sentence', () => {
    const a = ask('Tell me about verbs and objects');
    expect(a.grounding).toBe('course');
    expect(a.concepts).toEqual([]);
    expect(a.sections.map(s => [s.id, s.words])).toEqual([['record', ['verb', 'object']]]);
    expect(a.sections[0]!.snippet).toBe('Each statement has an actor, a verb and an object.');
    expect(a.answer).toBe('The part of this course closest to the question is “Recording learning”.');
  });

  it('does not count again the words a term already accounts for', () => {
    // "learning" is inside "Learning Record Store"; on its own it would match every section.
    expect(ask('What is a Learning Record Store?').sections.map(s => s.id)).toEqual(['record']);
  });

  it('lists the I2IDL terms the course uses, for a next question', () => {
    expect(ask('Tell me about verbs').courseTerms.map(t => t.label)).toEqual(['Experience API (xAPI)', 'Formative assessment', 'Learning engineering', 'Learning Record Store (LRS)']);
  });

  it('answers from the course alone when the glossary cannot be read', () => {
    const a = ask('Tell me about verbs', null);
    expect(a.glossaryUnavailable).toBe(true);
    expect(a.attribution).toBeUndefined();
    expect(a.sections.map(s => s.id)).toEqual(['record']);
    expect(ask('What is quantum chromodynamics?', null).answer).toBe('Nothing in this course matches that question. Try the words the course uses.');
    expect(ask('What is quantum chromodynamics?').grounding).toBe('none');
  });
});

describe('what an answer never is', () => {
  it('never reads an assessment, and is the same answer every time', () => {
    const a = ask('Which secret answer is right?');
    expect(a.sections).toEqual([]);   // the question is in the check's assessment, which is not read
    expect(JSON.stringify({ ...a, question: '' })).not.toMatch(/secret answer is right|deadbeef/i);
    expect(ask('What does formative assessment mean?')).toEqual(ask('What does formative assessment mean?'));
    expect(a.method).toMatch(/No model is called/);
  });

  it('reads Markdown as prose', () => {
    expect(plainText('## Title\n\nSome **bold** [link](https://x.example) and `code`.\n\n```\nblock\n```')).toBe('Title\n\nSome bold link and code.');
  });
});
