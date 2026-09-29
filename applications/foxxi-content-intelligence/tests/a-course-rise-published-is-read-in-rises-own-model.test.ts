/**
 * A COURSE RISE 360 PUBLISHED IS READ IN RISE'S OWN MODEL.
 *
 * A package Rise 360 published is one page its runtime draws everything into, so read as web
 * pages it has nothing to fold. The page carries the whole course as base64 JSON (rise-course.ts),
 * written three ways over Rise's versions: `window.courseData = "…"`, `deserialize("…")`, and a
 * locale file a `window.i18n` names. The fixtures here are made up, and shaped as real exports are.
 *
 * Here: the three encodings and the three layouts (SCORM, xAPI, a web export); each lesson a
 * topic, split at a continue divider, and a quiz lesson a topic of its questions; each kind of
 * block read as a page, and what is not text left out with why; questions right as Rise grades
 * them (a quiz by what its `correct` and `corrects` name, not the flags beside its answers); a
 * translated course; and each read folded and graded.
 */
import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { filesOfZip, foldPackage, type ImportedPackage, type ImportedQuestion } from '../src/package-import.js';
import { risePackage } from '../src/rise-course.js';
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
const b64 = (course: object): string => Buffer.from(JSON.stringify({ course, labelSet: { iso639Code: 'en' }, fonts: [], media: {} }), 'utf8').toString('base64');
const RUNTIME = '<script src="lib/player-0.0.11.min.js"></script><script src="lib/lzwcompress.js"></script>';

const text = (heading: string, paragraph: string, variant = 'heading paragraph'): object => ({ id: `t-${heading}`, type: 'text', family: 'text', variant, items: [{ heading, paragraph }] });
const kc = (item: object): object => ({ id: 'kc', type: 'knowledgeCheck', family: 'knowledgeCheck', variant: 'multiple choice', items: [item] });
const COURSE = {
  title: 'Sample: Safe lifting',
  lessons: [
    { id: 'sec1', type: 'section', title: 'Getting started', items: [] },
    { id: 'l1', type: 'blocks', title: 'Before you lift', description: '', items: [
      text('Plan the lift', '<p>Check the load <strong>before</strong> you lift.</p>'),
      { id: 'img', type: 'image', family: 'image', variant: 'hero', items: [{ caption: '<p>Keep your back straight.</p>', media: { image: { key: 'leaf-full.jpg', crushedKey: 'leaf-crushed.jpg', useCrushedKey: true } } }] },
      { id: 'list', type: 'list', family: 'list', variant: 'bulleted', items: [{ paragraph: '<p>Bend your knees</p>' }, { paragraph: '<p>Keep the load close</p>' }] },
      kc({ type: 'MULTIPLE_CHOICE', title: '<p>What do you check first?</p>', answers: [{ id: 'a1', title: '<p>The weather</p>', correct: false }, { id: 'a2', title: '<p>The load</p>', correct: true }] }),
      { id: 'cont', type: 'divider', family: 'continue', variant: 'continue', items: [{ title: 'Continue', type: '' }] },
      { id: 'acc', type: 'interactive', family: 'interactive', variant: 'accordion', items: [{ title: 'Why it matters', description: '<p>Back injuries are common.</p>' }] },
      { id: 'vid', type: 'multimedia', family: 'multimedia', variant: 'video', items: [{ caption: '<p>A demonstration.</p>', media: { video: { key: 'demo.mp4' } } }] },
      { id: 'att', type: 'multimedia', family: 'multimedia', variant: 'attachment', items: [{ media: { attachment: { key: 'guide.pdf', originalUrl: 'Lifting guide.pdf' } } }] },
      { id: 'sl', type: 'interactive', family: '360', variant: 'storyline', items: [{ media: { storyline: { src: 'story1/story.html' } } }] },
      kc({ type: 'FILL_IN_THE_BLANK', title: '<p>Lift with your ____.</p>', answers: [{ id: 1, title: 'legs', correct: true }, { id: 2, title: 'knees', correct: true }, { id: 3, title: 'back', correct: false }] }),
      kc({ type: 'MATCHING', title: '<p>Match each load to how to move it.</p>', answers: [{ id: 1, title: 'Light box', matchTitle: 'Carry', correct: false }, { id: 2, title: 'Heavy crate', matchTitle: 'Trolley', correct: false }] }),
      kc({ type: 'MULTIPLE_CHOICE', title: '<p>What is shown?</p>', media: { image: { key: 'x.jpg' } }, answers: [{ id: 1, title: 'A', correct: true }, { id: 2, title: 'B', correct: false }] }),
    ] },
    { id: 'quiz', type: 'quiz', title: 'Check your knowledge', description: '<p>Four questions.</p>', settings: { passingScore: 80, shuffleAnswerChoices: false }, items: [
      // The flags beside a quiz's answers are the editor's leftovers; the runtime grades what `correct` names.
      { id: 'q1', type: 'MULTIPLE_CHOICE', title: '<p>How many people lift a heavy crate?</p>', correct: 'x2', corrects: ['x1'],
        answers: [{ id: 'x1', title: '<p>One</p>', correct: true }, { id: 'x2', title: '<p>Two</p>', correct: false }] },
      { id: 'q2', type: 'MULTIPLE_RESPONSE', title: '<p>Which help?</p>', correct: '', corrects: ['1', '3'],
        answers: [{ id: 1, title: '<p>Gloves</p>', correct: true }, { id: 2, title: '<p>Rushing</p>', correct: true }, { id: 3, title: '<p>Boots</p>', correct: false }] },
      { id: 'q3', type: 'FILL_IN_THE_BLANK', title: '<p>Keep your back ____.</p>', settings: { isCaseSensitive: true },
        answers: [{ id: 1, title: 'straight', correct: false }, { id: 2, title: 'upright', correct: false }] },
      { id: 'q4', type: 'DRAW_FROM_QUESTION_BANK', questionBankId: 'bank', questionBankTitle: 'Bank', drawCount: 1, title: '', answers: [],
        questions: [{ id: 'bq1', type: 'MULTIPLE_CHOICE', title: '<p>Stop if it hurts?</p>', correct: 'y', answers: [{ id: 'y', title: '<p>Yes</p>' }, { id: 'n', title: '<p>No</p>' }] }] },
      { id: 'q5', type: 'HOTSPOT', title: '<p>Where?</p>', answers: [] },
    ] },
  ],
};
const MANIFEST = '<?xml version="1.0"?><manifest identifier="rise" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"><organizations default="articulate_rise"><organization identifier="articulate_rise"><title>Sample: Safe lifting</title><item identifier="i" identifierref="r"><title>Sample</title></item></organization></organizations>'
  + '<resources><resource identifier="r" type="webcontent" adlcp:scormtype="sco" href="scormdriver/indexAPI.html"><file href="scormdriver/indexAPI.html"/></resource></resources></manifest>';
/** A SCORM 1.2 package, its course in the newest encoding (`deserialize`). */
const scormPackage = (course: object = COURSE): AdmZip => zipOf({
  'imsmanifest.xml': MANIFEST,
  'scormdriver/indexAPI.html': '<html><body><iframe src="../scormcontent/index.html"></iframe></body></html>',
  'scormcontent/index.html': `<html><head>${RUNTIME}</head><body><div id="app"></div><script>async function __fetchCourse(){ return Promise.resolve(deserialize("${b64(course)}")) }</script></body></html>`,
  'scormcontent/assets/leaf-crushed.jpg': 'jpeg bytes',
  'scormcontent/assets/guide.pdf': 'pdf bytes',
});

/** Each question of a folded topic's check, as the engine stores it. */
const checkOf = (pkg: ImportedPackage, topic: number): ScormAssessmentQuestion[] => {
  const folded = foldPackage(pkg, { competency: 'lifting', blindFor: () => '0'.repeat(64) });
  const check = folded.items.find(i => i['@id'] === folded.topics[topic]!.check) as Fragment;
  return (check.questions ?? []) as ScormAssessmentQuestion[];
};

describe('a course Rise 360 published for SCORM', () => {
  const read = risePackage(filesOfZip(scormPackage()), { fileUrl })!;

  it('is read in its own model: each lesson a topic, a section only a heading in the list', () => {
    expect(read.title).toBe('Sample: Safe lifting');
    expect(read.topics.map(t => [t.id, t.title, t.pages.length, t.questions.length])).toEqual([
      ['l1', 'Before you lift', 2, 3],
      ['quiz', 'Check your knowledge', 1, 4],
    ]);
  });

  it('makes a lesson\'s blocks its pages, split where the course asks the learner to continue, its images the package\'s own', () => {
    expect(read.topics[0]!.pages).toEqual([
      {
        path: 'scormcontent/index.html#lessons/1', title: 'Before you lift',
        body: '# Plan the lift\n\nCheck the load **before** you lift.\n\n![](https://bridge.example/files/scormcontent/assets/leaf-crushed.jpg)\n\nKeep your back straight.\n\n- Bend your knees\n- Keep the load close',
      },
      {
        path: 'scormcontent/index.html#lessons/1/part/2', title: 'Before you lift, part 2',
        body: '## Why it matters\n\nBack injuries are common.\n\nA demonstration.\n\n[Lifting guide.pdf](https://bridge.example/files/scormcontent/assets/guide.pdf)',
      },
    ]);
    expect(read.topics[1]!.pages).toEqual([{ path: 'scormcontent/index.html#lessons/2', title: 'Check your knowledge', body: 'Four questions.' }]);
  });

  it('reads a knowledge check by the answers it flags', () => {
    expect(read.topics[0]!.questions).toEqual([
      { question: 'What do you check first?', type: 'choice', options: ['The weather', 'The load'], answer: 'B' },
      { question: 'Lift with your ____.', type: 'fill-in', answer: 'legs', accept: ['knees'], compare: 'exact' },
      { question: 'Match each load to how to move it.', type: 'matching', pairs: [['Light box', 'Carry'], ['Heavy crate', 'Trolley']] },
    ]);
  });

  it('reads a quiz as Rise grades it: what correct and corrects name, every fill-in answer it lists, its bank whole', () => {
    expect(read.topics[1]!.questions).toEqual([
      { question: 'How many people lift a heavy crate?', type: 'choice', options: ['One', 'Two'], answer: 'B' },
      { question: 'Which help?', type: 'choice', options: ['Gloves', 'Rushing', 'Boots'], answer: ['A', 'C'], multiple: true },
      { question: 'Keep your back ____.', type: 'fill-in', answer: 'straight', accept: ['upright'], caseSensitive: true, compare: 'exact' },
      { question: 'Stop if it hurts?', type: 'choice', options: ['Yes', 'No'], answer: 'A' },
    ]);
  });

  it('leaves out what is not text or a question it could ask, and says why', () => {
    expect(read.unread).toEqual([
      { path: 'scormcontent/index.html#lessons/1/items/6', why: 'a video, which is not text; its caption is kept' },
      { path: 'scormcontent/index.html#lessons/1/items/8', why: 'a Storyline interaction, which is a package of its own' },
      { path: 'scormcontent/index.html#lessons/1/items/11', why: 'its question comes with an image or a video, which a check here would not show' },
      { path: 'scormcontent/index.html#lessons/2/items/4', why: 'a hotspot question, which is not read' },
    ]);
  });

  it('folds into checks graded as Rise grades them', () => {
    const [load, legs, match] = checkOf(read, 0);
    expect(questionIsRight('B', load!)).toBe(true);
    expect(questionIsRight('knees', legs!)).toBe(true);
    expect(questionIsRight('LEGS', legs!)).toBe(true);
    expect(questionIsRight('back', legs!)).toBe(false);
    const targets = (match as ScormAssessmentQuestion & { input: { targets: string[] } }).input.targets;
    expect(questionIsRight(['Carry', 'Trolley'].map(t => String.fromCharCode(65 + targets.indexOf(t))).join(', '), match!)).toBe(true);
    const [two, help, back, stop] = checkOf(read, 1);
    // The leftover flag on "One" does not make it right; what `correct` names does.
    expect(questionIsRight('B', two!)).toBe(true);
    expect(questionIsRight('A', two!)).toBe(false);
    expect(questionIsRight('A, C', help!)).toBe(true);
    expect(questionIsRight('A, B', help!)).toBe(false);
    expect(questionIsRight('upright', back!)).toBe(true);
    expect(questionIsRight('Straight', back!)).toBe(false);
    expect(questionIsRight('A', stop!)).toBe(true);
  });

  it('is what the fold reads a hosted package as, before its pages', () => {
    expect(readAnyPackage(filesOfZip(scormPackage()), { fileUrl })).toEqual(read);
    // A SCORM package is hosted and played as one, not kept as an export.
    expect(projectExportOf(scormPackage().toBuffer())).toBeNull();
  });
});

describe('the other ways Rise has written a course', () => {
  const small = { title: 'Small', lessons: [{ id: 'only', type: 'blocks', title: 'Only lesson', items: [text('Hello', '<p>Words.</p>', 'heading paragraph')] }] };
  const bodies = (pkg: ImportedPackage | null): unknown => pkg?.topics.map(t => [t.title, t.pages.map(p => p.body)]);

  it('reads window.courseData, as an xAPI package keeps it at its root', () => {
    const xapi = zipOf({ 'tincan.xml': '<tincan/>', 'index.html': `<html><body><script>window.courseData = "${b64(small)}";</script></body></html>` });
    expect(bodies(risePackage(filesOfZip(xapi), { fileUrl }))).toEqual([['Only lesson', ['# Hello\n\nWords.']]]);
    // No manifest: an xAPI package is kept to be folded, as an export is.
    expect(projectExportOf(xapi.toBuffer())).toMatchObject({ tool: 'Rise 360', title: 'Small' });
  });

  it('reads a web export\'s locale file, the one window.i18n names', () => {
    const web = zipOf({
      'content/index.html': `<html><body><script>window.i18n = {"available":["und"],"default":"und"};</script></body></html>`,
      'content/locales/und.js': `__resolveJsonp("course:und", "${b64(small)}")`,
    });
    expect(bodies(risePackage(filesOfZip(web), { fileUrl }))).toEqual([['Only lesson', ['# Hello\n\nWords.']]]);
    expect(projectExportOf(web.toBuffer())).toMatchObject({ tool: 'Rise 360' });
  });

  it('reads a translated course\'s text in its own language', () => {
    const translated = {
      course: { title: { l10nId: 't1' }, lessons: [{ id: 'l', type: 'blocks', title: { l10nId: 't2' }, items: [{ id: 'b', type: 'text', family: 'text', variant: 'paragraph', items: [{ paragraph: { l10nId: 't3' } }] }] }] },
      l10n: { defaultLocale: 'fr', translations: { fr: { t1: 'Levage', t2: 'Avant', t3: '<p>Pliez les genoux.</p>' } } },
    };
    const zip = zipOf({ 'index.html': `<script>window.courseData = "${Buffer.from(JSON.stringify(translated)).toString('base64')}";</script>` });
    const read = risePackage(filesOfZip(zip), { fileUrl })!;
    expect([read.title, bodies(read)]).toEqual(['Levage', [['Avant', ['Pliez les genoux.']]]]);
  });

  it('turns the options a quiz shuffles, and is not what a page with no Rise course is', () => {
    const shuffled = { title: 'S', lessons: [{ id: 'q', type: 'quiz', title: 'Q', settings: { shuffleAnswerChoices: true }, items: [
      { id: 'q1', type: 'MULTIPLE_CHOICE', title: '<p>Pick the right one.</p>', correct: 'r', answers: [{ id: 'r', title: 'Right' }, { id: 'w1', title: 'Wrong one' }, { id: 'w2', title: 'Wrong two' }, { id: 'w3', title: 'Wrong three' }] },
    ] }] };
    const q = risePackage(filesOfZip(zipOf({ 'index.html': `<script>window.courseData = "${b64(shuffled)}";</script>` })), { fileUrl })!.topics[0]!.questions[0] as Extract<ImportedQuestion, { type: 'choice' }>;
    expect(q.options[(q.answer as string).charCodeAt(0) - 65]).toBe('Right');
    expect(q.options).not.toEqual(['Right', 'Wrong one', 'Wrong two', 'Wrong three']);
    expect(risePackage(filesOfZip(zipOf({ 'index.html': '<html><body><p>Just a page.</p></body></html>' })), { fileUrl })).toBeNull();
  });
});

describe('what a Rise block shows, as Rise shows it (a review of #578)', () => {
  const lesson = { id: 'l', type: 'blocks', title: 'Shown', items: [
    // Each variant shows its own fields: a leftover heading, a leftover paragraph, a statement's heading are not the course's.
    text('Leftover heading', '<p>Only the paragraph shows.</p>', 'paragraph'),
    text('Only the heading shows', '<p>Leftover paragraph.</p>', 'heading'),
    { id: 'st', type: 'text', family: 'impact', variant: 'b', items: [{ heading: 'Leftover statement heading', paragraph: 'Safety comes first.' }] },
    // Text that is not HTML, block after block, never runs together.
    { id: 'p2', type: 'text', family: 'text', variant: 'paragraph', items: [{ paragraph: 'Always check the load.' }] },
    { id: 'aside', type: 'image', family: 'image', variant: 'text aside', items: [{ caption: '<p>Leftover caption.</p>', paragraph: '<p>Text beside the picture.</p>', media: { image: { key: 'aside.jpg', useCrushedKey: false } } }] },
    { id: 'btn', type: 'interactive', family: 'buttons', variant: 'button stack', items: [
      { type: 'link', label: 'Open policy', destination: 'https://example.org/policy', description: '<p>Every employee must read the policy.</p>' },
      { type: 'relative-url', label: 'Checklist', destination: 'assets/checklist.pdf', description: '' },
      { type: 'relative-url', label: 'Missing', destination: 'assets/missing.pdf', description: '' },
      { type: 'email', label: 'Ask us', destination: 'safety@example.org', description: '' },
      { type: 'lesson', label: 'Next lesson', destination: 'l2', description: '' },
    ] },
    { id: 'fc', type: 'interactive', family: 'flashcard', variant: 'flashcard', items: [
      { front: { type: 'image', description: '<p>Front of the card</p>', media: { image: { key: 'front.jpg', useCrushedKey: false } } }, back: { type: 'description', description: '<p>Back of the card.</p>' } },
    ] },
    { id: 'acc', type: 'interactive', family: 'interactive', variant: 'accordion', items: [{ title: 'Watch', description: '<p>See it done.</p>', media: { video: { key: 'v.mp4' } } }] },
    // The editor's scratch media is no picture the question shows.
    kc({ type: 'MULTIPLE_CHOICE', title: '<p>Is scratch media shown?</p>', media: { tmp: { image: { key: 'x.jpg' } } }, answers: [{ id: 1, title: 'No', correct: true }, { id: 2, title: 'Yes', correct: false }] }),
  ] };
  const zip = zipOf({
    'index.html': `<script>window.courseData = "${b64({ title: 'Shown', lessons: [lesson] })}";</script>`,
    'assets/aside.jpg': 'jpeg', 'assets/front.jpg': 'jpeg', 'assets/checklist.pdf': 'pdf',
  });
  const read = risePackage(filesOfZip(zip), { fileUrl })!;

  it('reads each block\'s own fields, each block apart, a button\'s description and where it goes', () => {
    expect(read.topics[0]!.pages.map(p => p.body)).toEqual([[
      'Only the paragraph shows.',
      '# Only the heading shows',
      'Safety comes first.',
      'Always check the load.',
      '![](https://bridge.example/files/assets/aside.jpg)',
      'Text beside the picture.',
      'Every employee must read the policy.',
      '[Open policy](https://example.org/policy)',
      '[Checklist](https://bridge.example/files/assets/checklist.pdf)',
      'Ask us: safety@example.org',
      '## Front of the card',
      '![](https://bridge.example/files/assets/front.jpg)',
      'Back of the card.',
      '## Watch',
      'See it done.',
    ].join('\n\n')]);
    expect(read.topics[0]!.questions).toEqual([{ question: 'Is scratch media shown?', type: 'choice', options: ['No', 'Yes'], answer: 'A' }]);
  });

  it('reads a table as the text block its paragraph is (Codex, on #578)', () => {
    const table = { id: 'tb', type: 'text', family: 'text', variant: 'table', items: [{ paragraph: '<table><tr><th>Load</th><th>How</th></tr><tr><td>Light box</td><td>Carry</td></tr></table>' }] };
    const one = zipOf({ 'index.html': `<script>window.courseData = "${b64({ title: 'Tables', lessons: [{ id: 't', type: 'blocks', title: 'Loads', items: [table] }] })}";</script>` });
    expect(risePackage(filesOfZip(one), { fileUrl })!.topics[0]!.pages[0]!.body).toBe('| Load | How |\n| --- | --- |\n| Light box | Carry |');
  });

  it('lists what an item shows that is not text, and a button to what the package does not hold', () => {
    expect(read.unread).toEqual([
      { path: 'index.html#lessons/0/items/5', why: 'a button to assets/missing.pdf, which the package does not hold' },
      { path: 'index.html#lessons/0/items/7', why: 'a video in one of its items, which is not text' },
    ]);
  });

  it('ends a page before it grows past what a fragment holds, with no divider to end it', () => {
    const long = { id: 'long', type: 'blocks', title: 'Long', items: Array.from({ length: 60 }, (_, i) => text(`Point ${i + 1}`, `<p>${'Lift with your legs, not your back. '.repeat(16)}</p>`)) };
    const pages = risePackage(filesOfZip(zipOf({ 'index.html': `<script>window.courseData = "${b64({ title: 'Long', lessons: [long] })}";</script>` })), { fileUrl })!.topics[0]!.pages;
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every(p => p.body.length <= 20_000)).toBe(true);
    expect(pages.map(p => p.title).slice(0, 2)).toEqual(['Long', 'Long, part 2']);
    expect(pages.map(p => p.body).join('\n\n').match(/^# Point \d+$/gm)).toHaveLength(60);
  });
});
