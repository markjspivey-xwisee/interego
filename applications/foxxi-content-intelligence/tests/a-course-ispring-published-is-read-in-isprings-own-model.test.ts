/**
 * A COURSE ISPRING PUBLISHED IS READ IN ISPRING'S OWN MODEL.
 *
 * A package iSpring published is a player page its runtime draws each slide into, so read as web
 * pages it has nothing to fold. The page carries the course as a base64 string (ispring-course.ts):
 * a presentation's `presInfo` (zlib-deflated JSON), a quiz's `data` (QuizMaker 9.7 and later) or
 * `quizJson` (QuizMaker 8, deflated); a presentation's slides, quizzes and interactions have files
 * of their own in data/. The fixtures here are made up, and shaped as real exports are.
 *
 * Here: a presentation's outline as topics and its slides as pages (their text, pictures and
 * notes; not their background, text drawn as a picture, or a counter); an interaction as a page; a
 * quiz in a slide's place; each kind of question right as iSpring grades it, a blank or list at a
 * time; what is left out with why; a quiz QuizMaker made, 9.7 and later and 8; the layouts iSpring
 * publishes; and each read folded and graded.
 */
import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import AdmZip from 'adm-zip';
import { filesOfZip, foldPackage, type ImportedPackage, type ImportedQuestion } from '../src/package-import.js';
import { ispringPackage } from '../src/ispring-course.js';
import { projectExportOf, readAnyPackage } from '../src/tool-exports.js';
import { questionIsRight } from '../src/course-questions.js';
import type { ScormAssessmentQuestion } from '../src/scorm-assessment.js';
import type { Fragment } from '../src/content-fragments.js';

const fileUrl = (p: string): string => `https://bridge.example/files/${p}`;
const zipOf = (files: Record<string, string | Buffer>): AdmZip => {
  const zip = new AdmZip();
  for (const [name, body] of Object.entries(files)) zip.addFile(name, typeof body === 'string' ? Buffer.from(body, 'utf8') : body);
  return zip;
};
const b64 = (json: object): string => Buffer.from(JSON.stringify(json), 'utf8').toString('base64');
const deflated = (json: object): string => deflateSync(Buffer.from(JSON.stringify(json), 'utf8')).toString('base64');
const HEAD = '<!DOCTYPE html><!-- Created with iSpring --><!-- 960 640 --><!--version 11.7.0.5 --><!--type html -->';
/** Rich text as iSpring keeps it: styled HTML, clean HTML, and its text. */
const rt = (text: string): object => ({ h: `<p style="font-size:18px"><span style="color:#4d4d4d">${text}</span></p>`, a: `<p>${text}</p>`, r: [], d: [text] });
/** A sentence of blanks or lists: its text in pieces, each blank `{ id }` with its data. */
const sentence = (...pieces: Array<string | { id: string; type: string; data: object }>): object => ({
  a: `<p>${pieces.map(p => (typeof p === 'string' ? p : `<span id="${p.id}"></span>`)).join('')}</p>`,
  d: pieces.map(p => (typeof p === 'string' ? p : { id: p.id })),
  r: pieces.filter((p): p is { id: string; type: string; data: object } => typeof p !== 'string'),
});
const q = (tp: string, D: string, C: object, s: object = {}): object => ({ i: `q-${tp}-${D.length}`, tp, D: rt(D), v: true, C, s: { ee: true, e: { t: 'byQuestion', pt: 10 }, ...s }, a: { o: [] } });
const chs = (...cs: Array<[string, boolean?]>): object => ({ chs: cs.map(([t, c], i) => ({ i: `c${i}`, t: rt(t), ...(c === undefined ? {} : { c }) })) });

const QUIZ = { d: { T: 'Sample: Fire safety check', sl: { g: [{ T: 'Main', s: { st: 'allQuestions' }, S: [
  // The player shuffles these (`sh`); the right one is not always first.
  q('MultipleChoice', 'Which extinguisher is safe on an electrical fire?', chs(['Carbon dioxide', true], ['Water', false], ['Foam', false], ['Wet chemical', false]), { sh: true }),
  q('TrueFalse', `You should use a lift${String.fromCharCode(0x200b)} in a fire.`, chs(['True', false], ['False', true])),
  q('MultipleResponse', 'Which make up a fire triangle, %USER_NAME%?', chs(['Heat', true], ['Fuel', true], ['Water', false], ['Oxygen', true])),
  q('TypeIn', 'What do you pull first on an extinguisher?', { chs: [{ i: 't1', t: 'the pin' }, { i: 't2', t: 'pin' }] }),
  q('TypeIn', 'Which gas does a fire need? (a chemical symbol)', { chs: [{ i: 't3', t: 'O2' }] }, { cs: true }),
  q('FillInTheBlank', 'Complete the sentence.', { rt: sentence('Get ', { id: 'qmFillInTheBlank1', type: 'qmFillInTheBlank', data: { v: ['out', 'outside'] } }, ', stay out, and call ', { id: 'qmFillInTheBlank2', type: 'qmFillInTheBlank', data: { v: ['999'] } }, '.') }),
  q('MultipleChoiceText', 'Choose the right word.', { rt: sentence('Smoke rises.\nSo stay ', { id: 'qmMultipleChoiceText1', type: 'qmMultipleChoiceText', data: { v: ['high', 'low'], i: 1 } }, '.\nThen crawl out.') }, { sh: false }),
  q('WordBank', 'Drag the words.', { rt: sentence('Feel a door with the back of your:\n', { id: 'qmWordBank1', type: 'qmWordBank', data: { v: 'hand ' } }, '\nbefore you open it.'), ew: [{ t: 'foot' }] }),
  q('Matching', 'Match each class of fire to its fuel.', { m: [
    { p: { i: 'p1', t: rt('Class A') }, r: { i: 'r1', t: rt('Wood and paper') } },
    { p: { i: 'p2', t: rt('Class B') }, r: { i: 'r2', t: rt('Flammable liquids') } },
  ], d: { chs: [{ i: 'x1', t: rt('Metals') }] } }),
  q('Sequence', 'Put the steps in order.', chs(['Pull the pin'], ['Aim at the base'], ['Squeeze the handle'], ['Sweep side to side'])),
  q('Numeric', 'How many seconds does a small extinguisher last, roughly? (10 or 15 is fine)', { na: [{ co: 'equal', op: 10 }, { co: 'equal', op: 15 }] }),
  q('Numeric', 'Name a safe distance, in metres.', { na: [{ co: 'greaterThan', op: 2 }] }),
  q('InfoSlide', 'Part 2', { rt: rt('Now some scenarios.') }, { ee: false }),
  q('Essay', 'Describe your escape route.', {}, { ee: false }),
  q('Hotspot', 'Click the exit.', { a: [{ t: 'rectangle', r: { x: 1, y: 1, w: 2 }, c: true }] }),
  q('DND', 'Drag each sign onto its meaning.', { d: [{ o: { s: 'Text Box 1' }, d: { s: 'Picture 2' } }] }),
  { ...(q('MultipleChoice', 'What does this sign show?', chs(['An exit', true], ['A lift', false])) as object), at: { i: 'storage://images/img-1.png' } },
  q('MultipleChoice', 'How was your experience?', chs(['Good'], ['Bad']), { ee: false }),
] }] } } };

/** A presentation's slide file: its layers as HTML, a single-quoted JavaScript string. */
const slideFile = (index: number, html: string): string =>
  `(function(){var loadHandler=window['sl_{GUID}'];loadHandler&&loadHandler(${index}, '${html.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', '{"s":[]}');})();`;
const PRES = { i: '{GUID}', t: 'Sample: Fire safety', ct: 'Sample: Fire safety', w: 960, h: 540, s: [
  // Its first line is its title; a picture, text drawn as a picture, a background; notes; narration.
  { t: '', l: 0, x: 'Fire safety\r\nKnow your exits.\rStay low under smoke.', s: 'data/slide1.js', N: '<p>Welcome the <b>group</b>.</p>', S: [{ a: 'snd1_x', d: 3 }] },
  // Its own title, and a counter.
  { t: 'Extinguishers', l: 1, x: 'Pull, aim, squeeze, sweep.\r\n2/5', s: 'data/slide2.js' },
  { t: '', l: 1, st: 'i', it: 'iSpring.Tabs', s: 'data/intr1.js' },
  { t: 'Check', l: 0, st: 'q', s: 'data/quiz1.js' },
  { t: 'Watch', l: 0, x: 'Watch the drill.', s: 'data/slide3.js', V: [{ h: '<video poster="data/img9.png"><source src="data/video1.mp4"></video>' }], wo: [{ u: 'https://example.org' }] },
] };
const INTERACTION = { d: { i: 'interactivity_1', C: { is: [
  { i: 'a', t: rt('Water'), c: { a: '<p>For wood and paper.</p>' } },
  { i: 'b', t: rt('Foam'), c: { a: '<p>For liquids.</p>' } },
] } } };
const PRES_FILES = (root = ''): Record<string, string | Buffer> => ({
  [`${root}index.html`]: `${HEAD}<!--mainFolder ./ --><html><head><title>Sample: Fire safety</title></head><body><script>var presInfo="${deflated(PRES)}";PresentationPlayer.start(presInfo,"content","playerView");</script></body></html>`,
  [`${root}data/slide1.js`]: slideFile(0, '<div id="spr0_a"><div id="spr1_a" class="kern slide"><img id="img0_a" src="data/img0.png" width="120px" height="60px" alt="Company logo"/></div><div id="spr2_a" class="kern slide"><img id="img1_a" src="data/img1.png" width="300" height="200" alt="An exit sign"/><img id="img2_a" src="data/img2.png" width="200" height="40" alt="Know your exits."/><span id="txt0_a">Fire safety</span></div></div>'),
  [`${root}data/slide2.js`]: slideFile(1, '<div id="spr0_b"><div id="spr2_b" class="kern slide"><img id="img3_b" src="data/img3.jpg" width="960" height="540" alt="background.jpg"/></div></div>'),
  [`${root}data/slide3.js`]: slideFile(4, '<div id="spr0_c"><div id="spr2_c" class="kern slide"></div></div>'),
  [`${root}data/intr1.js`]: `(function(){var loadHandler = window['i_{GUID}']; var interactionJson = "${b64(INTERACTION)}"; loadHandler&&loadHandler(2,'interactivity_1',interactionJson);})();`,
  [`${root}data/quiz1.js`]: `(function(){\n\tvar loadHandler=window['q_{GUID}'];\n\tvar quizInfo = "${b64(QUIZ)}";\n\tloadHandler&&loadHandler(3,'quiz1',quizInfo);})();`,
  [`${root}data/img0.png`]: 'png', [`${root}data/img1.png`]: 'png', [`${root}data/img2.png`]: 'png', [`${root}data/img3.jpg`]: 'jpg',
});

/** Each question of a folded topic's check, as the engine stores it. */
const checkOf = (pkg: ImportedPackage, topic: number): ScormAssessmentQuestion[] => {
  const folded = foldPackage(pkg, { competency: 'fire-safety', blindFor: () => '0'.repeat(64) });
  const check = folded.items.find(i => i['@id'] === folded.topics[topic]!.check) as Fragment;
  return (check.questions ?? []) as ScormAssessmentQuestion[];
};
const letterOf = (q: ImportedQuestion, option: string): string => String.fromCharCode(65 + (q as Extract<ImportedQuestion, { type: 'choice' }>).options.indexOf(option));

describe('a presentation iSpring published for the web', () => {
  const read = ispringPackage(filesOfZip(zipOf(PRES_FILES())), { fileUrl })!;

  it('is read in its own model: a topic for each slide at the top of its outline, its title the presentation\'s', () => {
    expect(read.title).toBe('Sample: Fire safety');
    expect(read.topics.map(t => [t.title, t.pages.length, t.questions.length])).toEqual([
      ['Fire safety', 3, 0],
      ['Check', 1, 12],
      ['Watch', 1, 0],
    ]);
  });

  it('makes each slide a page: its text shape by shape, its pictures, its notes; not its background, text drawn as a picture, or a counter', () => {
    expect(read.topics[0]!.pages).toEqual([
      {
        path: 'data/slide1.js', title: 'Fire safety',
        body: 'Know your exits.\n\nStay low under smoke.\n\n![An exit sign](https://bridge.example/files/data/img1.png)\n\n# Notes\n\nWelcome the **group**.',
      },
      { path: 'data/slide2.js', title: 'Extinguishers', body: 'Pull, aim, squeeze, sweep.' },
      // An interaction's items, a heading each.
      { path: 'data/intr1.js', title: 'Tabs', body: '# Water\n\nFor wood and paper.\n\n# Foam\n\nFor liquids.' },
    ]);
    expect(read.topics[1]!.pages).toEqual([{ path: 'index.html#slides/3/groups/0/12', title: 'Part 2', body: 'Now some scenarios.' }]);
  });

  it('reads each question as iSpring grades it, a blank or a list at a time', () => {
    const [shuffled, ...rest] = read.topics[1]!.questions;
    // The player shuffles these (`sh`): turned, so the right one is not always first.
    expect([...(shuffled as Extract<ImportedQuestion, { type: 'choice' }>).options].sort()).toEqual(['Carbon dioxide', 'Foam', 'Water', 'Wet chemical']);
    expect((shuffled as Extract<ImportedQuestion, { type: 'choice' }>).options[0]).not.toBe('Carbon dioxide');
    expect((shuffled as Extract<ImportedQuestion, { type: 'choice' }>).answer).toBe(letterOf(shuffled!, 'Carbon dioxide'));
    expect(rest).toEqual([
      { question: 'You should use a lift in a fire.', type: 'choice', options: ['True', 'False'], answer: 'B' },
      { question: 'Which make up a fire triangle, …?', type: 'choice', options: ['Heat', 'Fuel', 'Water', 'Oxygen'], answer: ['A', 'B', 'D'], multiple: true },
      { question: 'What do you pull first on an extinguisher?', type: 'fill-in', answer: 'the pin', accept: ['pin'], compare: 'exact' },
      { question: 'Which gas does a fire need? (a chemical symbol)', type: 'fill-in', answer: 'O2', caseSensitive: true, compare: 'exact' },
      { question: 'Complete the sentence.\n\nGet ____, stay out, and call ….', type: 'fill-in', answer: 'out', accept: ['outside'], compare: 'exact' },
      { question: 'Complete the sentence.\n\nGet …, stay out, and call ____.', type: 'fill-in', answer: '999', compare: 'exact' },
      { question: 'Choose the right word.\n\nSo stay ____.', type: 'choice', options: ['high', 'low'], answer: 'B' },
      // A word bank's words, the extra ones too, in alphabetical order.
      { question: 'Drag the words.\n\nFeel a door with the back of your:\n____', type: 'choice', options: ['foot', 'hand'], answer: 'B' },
      { question: 'Match each class of fire to its fuel.', type: 'matching', pairs: [['Class A', 'Wood and paper'], ['Class B', 'Flammable liquids']], distractors: ['Metals'] },
      { question: 'Put the steps in order.', type: 'sequencing', items: ['Pull the pin', 'Aim at the base', 'Squeeze the handle', 'Sweep side to side'] },
      { question: 'How many seconds does a small extinguisher last, roughly? (10 or 15 is fine)', type: 'numeric', answer: 10, accept: [15] },
    ]);
  });

  it('leaves out what is not text or a question it could ask, and says why', () => {
    const q = (i: number): string => `index.html#slides/3/groups/0/${i}`;
    expect(read.unread).toEqual([
      { path: q(11), why: 'its right answer is a range or a comparison, not a value' },
      { path: q(13), why: 'a survey question, which grades nothing' },
      { path: q(14), why: 'a hotspot question, which a check here would not show' },
      { path: q(15), why: 'a drag-and-drop onto the slide, which a check here would not show' },
      { path: q(16), why: 'its question comes with an image or a video, which a check here would not show' },
      { path: q(17), why: 'a survey question, which grades nothing' },
      { path: 'index.html#slides/4', why: 'a video, which is not text' },
      { path: 'index.html#slides/4', why: 'a web object, which is not read' },
      { path: 'index.html', why: 'narration on one slide, which is not text' },
    ]);
  });

  it('folds into checks graded as iSpring grades them', () => {
    const [extinguisher, lift, triangle, pin, gas, out, call, low, hand, classes, steps, seconds] = checkOf(read, 1);
    const qs = read.topics[1]!.questions;
    expect(questionIsRight(letterOf(qs[0]!, 'Carbon dioxide'), extinguisher!)).toBe(true);
    expect(questionIsRight(letterOf(qs[0]!, 'Water'), extinguisher!)).toBe(false);
    expect(questionIsRight('B', lift!)).toBe(true);
    expect(questionIsRight('A, B, D', triangle!)).toBe(true);
    expect(questionIsRight('A, B', triangle!)).toBe(false);
    expect(questionIsRight('Pin', pin!)).toBe(true);
    expect(questionIsRight('the pin!', pin!)).toBe(false);
    expect(questionIsRight('O2', gas!)).toBe(true);
    expect(questionIsRight('o2', gas!)).toBe(false);
    expect(questionIsRight('outside', out!)).toBe(true);
    expect(questionIsRight('999', call!)).toBe(true);
    expect(questionIsRight('B', low!)).toBe(true);
    expect(questionIsRight('B', hand!)).toBe(true);
    const targets = (classes as ScormAssessmentQuestion & { input: { targets: string[] } }).input.targets;
    expect(questionIsRight(['Wood and paper', 'Flammable liquids'].map(t => String.fromCharCode(65 + targets.indexOf(t))).join(', '), classes!)).toBe(true);
    const shown = (steps as ScormAssessmentQuestion & { input: { items: string[] } }).input.items;
    expect(questionIsRight(['Pull the pin', 'Aim at the base', 'Squeeze the handle', 'Sweep side to side'].map(t => String.fromCharCode(65 + shown.indexOf(t))).join(', '), steps!)).toBe(true);
    expect(questionIsRight('15', seconds!)).toBe(true);
    expect(questionIsRight('12', seconds!)).toBe(false);
  });

  it('is what the fold reads a hosted package as, and one published for the web is kept as an export', () => {
    expect(readAnyPackage(filesOfZip(zipOf(PRES_FILES())), { fileUrl })).toEqual(read);
    expect(projectExportOf(zipOf(PRES_FILES()).toBuffer())).toMatchObject({ tool: 'iSpring', title: 'Sample: Fire safety' });
  });
});

describe('the other ways iSpring publishes a course', () => {
  it('reads a SCORM package\'s player page in res/, and plays the package as one', () => {
    const scorm = zipOf({ 'imsmanifest.xml': '<manifest identifier="i"><organizations/><resources><resource identifier="r" href="res/index.html"/></resources></manifest>', ...PRES_FILES('res/') });
    const read = ispringPackage(filesOfZip(scorm), { fileUrl })!;
    expect(read.topics[0]!.pages[0]!.path).toBe('res/data/slide1.js');
    expect(read.topics[0]!.pages[0]!.body).toContain('(https://bridge.example/files/res/data/img1.png)');
    expect(projectExportOf(scorm.toBuffer())).toBeNull();
  });

  it('reads a quiz QuizMaker made on its own: a topic for each group, one drawn at random asked whole', () => {
    const quiz = { d: { T: 'Sample: Ladder check', sl: { g: [
      { T: 'Basics', s: { st: 'allQuestions' }, S: [q('TrueFalse', 'A ladder may lean on a window.', chs(['True', false], ['False', true]))] },
      { T: 'Drawn at random', s: { st: 'randomSelection', rs: 1 }, S: [
        q('MultipleChoice', 'How far out per four feet up?', chs(['One foot', true], ['Two feet', false])),
        q('TypeIn', 'What do you check first?', { chs: [{ i: 'a', t: 'the feet' }] }),
      ] },
    ] } } };
    const zip = zipOf({ 'index.html': `${HEAD}<!--content quiz --><!--mainFolder --><script>var data="${b64(quiz)}";QuizPlayer.start("content","quiz1",data);</script>` });
    const read = ispringPackage(filesOfZip(zip), { fileUrl })!;
    expect(read.title).toBe('Sample: Ladder check');
    expect(read.topics.map(t => [t.title, t.questions.length])).toEqual([['Basics', 1], ['Drawn at random', 2]]);
    expect(projectExportOf(zip.toBuffer())).toMatchObject({ tool: 'iSpring', title: 'Sample: Ladder check' });
  });

  it('reads a quiz QuizMaker 8 made, which shuffles answers unless it says not', () => {
    const quiz8 = { t: 'g', T: 'Sample: Old quiz', q: [
      { t: 'mc', i: '{1}', d: '<p style="font-size:18px"><span>Which way does smoke move?</span></p>', a: [{ t: '<p>Up</p>', c: true }, { t: '<p>Down</p>' }, { t: '<p>Sideways</p>' }] },
      { t: 'mc', i: '{2}', sh: false, d: 'Pick the second choice.', a: [{ t: 'First' }, { t: 'Second', c: true }] },
      { t: 'mc', i: '{8}', d: 'Pick one.', a: [{ t: 'Same' }, { t: 'same', c: true }] },
      { t: 'mr', i: '{3}', d: 'Which are exits?', a: [{ t: 'Door', c: true }, { t: 'Lift' }, { t: 'Stairs', c: true }] },
      { t: 'yn', i: '{4}', d: 'Did you enjoy this?', a: [{ t: 'Yes' }, { t: 'No' }] },
      { t: 'm', i: '{5}', d: 'Match.', P: [{ i: '0', t: '<p>Class A</p>' }, { i: '1', t: '<p>Class B</p>' }], R: [{ i: '0', t: '<p>Paper</p>' }, { i: '1', t: '<p>Oil</p>' }], M: [{ p: '0', r: '0' }, { p: '1', r: '1' }] },
      { t: 'wb', i: '{6}', d: 'Fill the gap.', D: ['<p>Stay </p>', { p: '<p>low</p>' }, '<p> in smoke.</p>'], e: [{ p: 'high' }] },
      { t: 'e', i: '{7}', d: 'Describe your plan.' },
    ] };
    const read = ispringPackage(filesOfZip(zipOf({ 'index.html': `${HEAD}<script>var quizJson="${deflated(quiz8)}";QuizPlayerSolid.start("q_1");</script>` })), { fileUrl })!;
    const [smoke, ...rest] = read.topics[0]!.questions;
    expect((smoke as Extract<ImportedQuestion, { type: 'choice' }>).options).not.toEqual(['Up', 'Down', 'Sideways']);
    expect((smoke as Extract<ImportedQuestion, { type: 'choice' }>).answer).toBe(letterOf(smoke!, 'Up'));
    expect(rest).toEqual([
      { question: 'Pick the second choice.', type: 'choice', options: ['First', 'Second'], answer: 'B' },
      expect.objectContaining({ question: 'Which are exits?', type: 'choice', multiple: true }),
      { question: 'Match.', type: 'matching', pairs: [['Class A', 'Paper'], ['Class B', 'Oil']] },
      { question: 'Fill the gap.\n\nStay ____ in smoke.', type: 'choice', options: ['high', 'low'], answer: 'B' },
    ]);
    expect(read.unread).toEqual([
      { path: 'index.html#questions/2', why: 'two of its choices read the same, so which is which is only where each is' },
      { path: 'index.html#questions/4', why: 'it marks no answer correct' },
      { path: 'index.html#questions/7', why: 'a survey question, which grades nothing' },
    ]);
  });

  it('makes a long presentation with no outline topics of fifty slides', () => {
    const slides = Array.from({ length: 100 }, (_, i) => ({ t: `Step ${i + 1}`, l: 0, x: `Do step ${i + 1}.` }));
    const zip = zipOf({ 'index.html': `${HEAD}<script>var presInfo="${deflated({ t: 'Long deck', w: 960, h: 540, s: slides })}";</script>` });
    expect(ispringPackage(filesOfZip(zip), { fileUrl })!.topics.map(t => [t.title, t.pages.length])).toEqual([['Long deck: slides 1 to 50', 50], ['Long deck: slides 51 to 100', 50]]);
  });

  it('reads each presentation in a zip of several', () => {
    const read = readAnyPackage(filesOfZip(zipOf({ ...PRES_FILES('part-1/'), ...PRES_FILES('part-2/') })), { fileUrl, title: 'Both parts' });
    expect(read.title).toBe('Both parts');
    expect(read.topics.map(t => [t.id, t.pages[0]?.path ?? ''])).toEqual([
      ['part-1/slides/0', 'part-1/data/slide1.js'], ['part-1/slides/3', 'part-1/index.html#slides/3/groups/0/12'], ['part-1/slides/4', 'part-1/data/slide3.js'],
      ['part-2/slides/0', 'part-2/data/slide1.js'], ['part-2/slides/3', 'part-2/index.html#slides/3/groups/0/12'], ['part-2/slides/4', 'part-2/data/slide3.js'],
    ]);
  });

  it('reads nothing that is not an iSpring course: a page without its mark, or a book', () => {
    expect(ispringPackage(filesOfZip(zipOf({ 'index.html': `<script>var presInfo="${deflated(PRES)}";</script>` })), { fileUrl })).toBeNull();
    expect(ispringPackage(filesOfZip(zipOf({ 'index.html': `${HEAD}<!--content book --><script>var bookInfo="${b64({ b: 1 })}";</script>` })), { fileUrl })).toBeNull();
  });
});
