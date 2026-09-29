/**
 * A PACKAGE AN AUTHORING TOOL MADE IS READ IN THAT TOOL'S OWN MODEL.
 *
 * Read as web pages, a package Adapt or H5P made is mostly "no text of its own: what it shows, its
 * script draws": its runtime draws every page from data kept beside it. That data is the course, so
 * tool-exports.ts reads it: an Adapt course's pages, articles, blocks and components (built to be
 * played, or exported as source), and H5P's content (an .h5p file, or H5P a package plays), into
 * the model a hosted package folds from. The fold route reads every hosted package this way first.
 *
 * Here: an Adapt build and an Adapt source export, H5P's book, presentation and question types,
 * what each leaves out and why, the turning of options a tool shows shuffled, a package made by
 * neither, and each read folded and graded as the tool says is right.
 */
import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { filesOfZip, foldPackage, PackageError, type ImportedPackage, type ImportedQuestion } from '../src/package-import.js';
import { adaptPackage, h5pPackage, readAnyPackage } from '../src/tool-exports.js';
import { questionIsRight } from '../src/course-questions.js';
import type { ScormAssessmentQuestion } from '../src/scorm-assessment.js';
import type { Fragment } from '../src/content-fragments.js';

const fileUrl = (p: string): string => `https://bridge.example/files/${p}`;
const zipOf = (files: Record<string, string | object>): AdmZip => {
  const zip = new AdmZip();
  for (const [name, body] of Object.entries(files)) zip.addFile(name, Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'));
  return zip;
};
const MANIFEST = '<?xml version="1.0"?><manifest identifier="m"><organizations/><resources><resource identifier="r" type="webcontent" adlcp:scormType="sco" href="index.html"><file href="index.html"/></resource></resources></manifest>';
const RUNTIME_PAGE = '<html><head><title>Course</title></head><body><div id="wrapper"></div><script src="adapt/js/adapt.min.js"></script></body></html>';
/** Each question of a folded topic's check, as the engine stores it. */
const checkOf = (pkg: ImportedPackage, topic = 0): ScormAssessmentQuestion[] => {
  const folded = foldPackage(pkg, { competency: 'tools', blindFor: () => '0'.repeat(64) });
  const check = folded.items.find(i => i['@id'] === folded.topics[topic]!.check) as Fragment;
  return (check.questions ?? []) as ScormAssessmentQuestion[];
};
const letterOf = (i: number): string => String.fromCharCode(65 + i);

// ── Adapt ───────────────────────────────────────────────────────────

const adaptCourse = {
  course: { _id: 'course', _type: 'course', title: 'safe-lifting', displayTitle: 'Safe Lifting' },
  contentObjects: [
    { _id: 'co-05', _parentId: 'course', _type: 'page', displayTitle: 'Before you lift', body: '<p>Plan the lift.</p>' },
    { _id: 'co-10', _parentId: 'course', _type: 'menu', displayTitle: 'More' },
    { _id: 'co-15', _parentId: 'co-10', _type: 'page', displayTitle: 'Moving loads' },
    { _id: 'co-20', _parentId: 'course', _type: 'page', displayTitle: 'Retired', _isAvailable: false },
  ],
  articles: [
    { _id: 'a-05', _parentId: 'co-05', _type: 'article', displayTitle: 'Assess the load' },
    { _id: 'a-10', _parentId: 'co-15', _type: 'article', displayTitle: '' },
  ],
  blocks: [
    { _id: 'b-05', _parentId: 'a-05', _type: 'block', displayTitle: 'Weight' },
    { _id: 'b-10', _parentId: 'a-05', _type: 'block', displayTitle: 'Check' },
    { _id: 'b-15', _parentId: 'a-10', _type: 'block', displayTitle: 'Carrying' },
  ],
  components: [
    { _id: 'c-05', _parentId: 'b-05', _type: 'component', _component: 'text', displayTitle: 'How heavy?', body: '<p>Test the weight <em>first</em>.</p>' },
    { _id: 'c-10', _parentId: 'b-05', _type: 'component', _component: 'graphic', _graphic: { large: 'course/en/images/lift.jpg', small: 'course/en/images/lift-small.jpg', alt: 'A safe lift' } },
    { _id: 'c-15', _parentId: 'b-10', _type: 'component', _component: 'mcq', displayTitle: 'Question 1', body: '<p>What do you check first?</p>', _selectable: 1,
      _items: [{ text: 'The weather', _shouldBeSelected: false }, { text: 'The weight', _shouldBeSelected: true }] },
    { _id: 'c-20', _parentId: 'b-10', _type: 'component', _component: 'mcq', body: '<p>Which help?</p>', _selectable: 2,
      _items: [{ text: 'Gloves', _shouldBeSelected: true }, { text: 'Rushing', _shouldBeSelected: false }, { text: 'Boots', _shouldBeSelected: true }] },
    { _id: 'c-22', _parentId: 'b-10', _type: 'component', _component: 'mcq', body: '<p>Pick what applies.</p>', _selectable: 2,
      _items: [{ text: 'Lift alone', _shouldBeSelected: false }, { text: 'Ask for help', _shouldBeSelected: true }] },
    { _id: 'c-25', _parentId: 'b-10', _type: 'component', _component: 'textinput', body: '<p>Fill in.</p>',
      _items: [{ prefix: 'Bend your', suffix: '.', _answers: ['knees', 'legs'] }, { prefix: 'Keep your back', _answers: ['straight'] }] },
    { _id: 'c-30', _parentId: 'b-10', _type: 'component', _component: 'matching', body: '<p>Match each load to how to move it.</p>', _items: [
      { text: 'Light box', _options: [{ text: 'Carry', _isCorrect: true }, { text: 'Trolley', _isCorrect: false }, { text: 'Crane', _isCorrect: false }] },
      { text: 'Heavy crate', _options: [{ text: 'Carry', _isCorrect: false }, { text: 'Trolley', _isCorrect: true }, { text: 'Crane', _isCorrect: false }] },
    ] },
    { _id: 'c-35', _parentId: 'b-10', _type: 'component', _component: 'slider', body: '<p>How many kilograms may one person lift?</p>', _scaleStart: 0, _scaleEnd: 50, _correctAnswer: '25' },
    { _id: 'c-40', _parentId: 'b-10', _type: 'component', _component: 'slider', body: '<p>Pick a safe range.</p>', _scaleStart: 0, _scaleEnd: 50, _correctAnswer: '', _correctRange: { _bottom: 10, _top: 20 } },
    { _id: 'c-42', _parentId: 'b-10', _type: 'component', _component: 'slider', body: '<p>How far?</p>', _scaleStart: 0, _scaleEnd: 50, _correctAnswer: 60 },
    { _id: 'c-45', _parentId: 'b-10', _type: 'component', _component: 'gmcq', body: '<p>Which picture shows it?</p>',
      _items: [{ text: 'This', _graphic: { large: 'course/en/images/a.jpg' }, _shouldBeSelected: true }, { text: 'That', _graphic: { large: 'course/en/images/b.jpg' } }] },
    { _id: 'c-50', _parentId: 'b-15', _type: 'component', _component: 'accordion', displayTitle: 'Tips', body: '',
      _items: [{ title: 'Close', body: '<p>Keep the load close.</p>' }, { title: 'Turn', body: '<p>Turn with your feet.</p>' }] },
    { _id: 'c-55', _parentId: 'b-15', _type: 'component', _component: 'media', displayTitle: 'Watch', body: '<p>A demonstration.</p>', _media: { mp4: 'course/en/video/demo.mp4' } },
    { _id: 'c-60', _parentId: 'b-15', _type: 'component', _component: 'text', body: '<p>Not shown.</p>', _isAvailable: false },
  ],
};
const adaptBuild = zipOf({
  'imsmanifest.xml': MANIFEST, 'index.html': RUNTIME_PAGE,
  'course/config.json': { _defaultLanguage: 'en' },
  'course/en/course.json': adaptCourse.course,
  'course/en/contentObjects.json': adaptCourse.contentObjects,
  'course/en/articles.json': adaptCourse.articles,
  'course/en/blocks.json': adaptCourse.blocks,
  'course/en/components.json': adaptCourse.components,
  'course/en/images/lift.jpg': 'jpeg bytes',
});

describe('a course Adapt built', () => {
  const read = adaptPackage(filesOfZip(adaptBuild), { fileUrl })!;

  it('is read in its own model: each page a topic, in the course\'s order, a menu\'s pages where the menu is', () => {
    expect(read.title).toBe('Safe Lifting');
    expect(read.topics.map(t => [t.id, t.title, t.pages.length, t.questions.length])).toEqual([
      ['co-05', 'Before you lift', 2, 7],
      ['co-15', 'Moving loads', 1, 0],
    ]);
  });

  it('makes each article a page: its blocks under their titles, its components in order, its images the package\'s own', () => {
    expect(read.topics[0]!.pages).toEqual([
      { path: 'course/en/contentObjects.json#co-05', title: 'Before you lift', body: 'Plan the lift.' },
      {
        path: 'course/en/articles.json#a-05', title: 'Assess the load',
        body: '# Weight\n\n## How heavy?\n\nTest the weight *first*.\n\n![A safe lift](https://bridge.example/files/course/en/images/lift.jpg)',
      },
    ]);
    // An article with no title of its own takes its page's; an accordion's items are read in turn.
    expect(read.topics[1]!.pages).toEqual([{
      path: 'course/en/articles.json#a-10', title: 'Moving loads',
      body: '# Carrying\n\n## Tips\n\n**Close**\n\nKeep the load close.\n\n**Turn**\n\nTurn with your feet.\n\n## Watch\n\nA demonstration.',
    }]);
  });

  it('reads each question component as the tool marks it right', () => {
    expect(read.topics[0]!.questions).toEqual([
      { question: 'What do you check first?', type: 'choice', options: ['The weather', 'The weight'], answer: 'B' },
      { question: 'Which help?', type: 'choice', options: ['Gloves', 'Rushing', 'Boots'], answer: ['A', 'C'], multiple: true },
      { question: 'Pick what applies.', type: 'choice', options: ['Lift alone', 'Ask for help'], answer: ['B'], multiple: true },
      { question: 'Fill in.\n\nBend your ____.', type: 'fill-in', answer: 'knees', accept: ['legs'], caseSensitive: true },
      { question: 'Fill in.\n\nKeep your back ____', type: 'fill-in', answer: 'straight', caseSensitive: true },
      { question: 'Match each load to how to move it.', type: 'matching', pairs: [['Light box', 'Carry'], ['Heavy crate', 'Trolley']], distractors: ['Crane'] },
      { question: 'How many kilograms may one person lift?', type: 'numeric', answer: 25, min: 0, max: 50 },
    ]);
  });

  it('leaves out what the course does not show or a check here could not ask, and says why', () => {
    expect(read.unread).toEqual([
      { path: 'course/en/contentObjects.json#co-20', why: 'its author made it unavailable, so the course does not show it' },
      { path: 'course/en/components.json#c-40', why: 'it marks a range as right, not one value' },
      { path: 'course/en/components.json#c-42', why: 'its right value is off its own scale' },
      { path: 'course/en/components.json#c-45', why: 'its options are pictures, which a check here would not show' },
      { path: 'course/en/components.json#c-55', why: 'a video or audio, which is not text; its title and body are kept' },
      { path: 'course/en/components.json#c-60', why: 'its author made it unavailable, so the course does not show it' },
    ]);
  });

  it('folds into checks graded as the tool marks each answer right', () => {
    const [pick, several, applies, bend, back, match, kilos] = checkOf(read);
    expect(questionIsRight('B', pick!)).toBe(true);
    expect(questionIsRight('A', pick!)).toBe(false);
    expect(questionIsRight('A, C', several!)).toBe(true);
    expect(questionIsRight('A', several!)).toBe(false);
    expect(questionIsRight('B', applies!)).toBe(true);
    expect(questionIsRight('A, B', applies!)).toBe(false);
    expect(questionIsRight('knees', bend!)).toBe(true);
    expect(questionIsRight('legs', bend!)).toBe(true);
    expect(questionIsRight('arms', bend!)).toBe(false);
    // Letter case counts, as the tool grades it unless its author allows any case.
    expect(questionIsRight('Knees', bend!)).toBe(false);
    expect(questionIsRight('straight', back!)).toBe(true);
    const shown = (match as ScormAssessmentQuestion & { input: { targets: string[] } }).input.targets;
    expect(questionIsRight(['Carry', 'Trolley'].map(t => letterOf(shown.indexOf(t))).join(', '), match!)).toBe(true);
    expect(questionIsRight(['Trolley', 'Carry'].map(t => letterOf(shown.indexOf(t))).join(', '), match!)).toBe(false);
    expect(questionIsRight('25', kilos!)).toBe(true);
    expect(questionIsRight('24', kilos!)).toBe(false);
  });

  it('is what the fold reads a hosted package as, before its pages', () => {
    expect(readAnyPackage(filesOfZip(adaptBuild), { fileUrl })).toEqual(read);
  });
});

describe('a course Adapt exported as source', () => {
  // The items in one file each language, typed by what they say they are; French is the default.
  const items = (lang: string): object[] => [
    { _id: 'course', _type: 'course', displayTitle: lang === 'fr' ? 'Levage' : 'Lifting' },
    { _id: 'p1', _parentId: 'course', _type: 'page', displayTitle: lang === 'fr' ? 'Avant' : 'Before' },
    { _id: 'a1', _parentId: 'p1', _type: 'article', displayTitle: 'A' },
    { _id: 'b1', _parentId: 'a1', _type: 'block' },
    { _id: 'c1', _parentId: 'b1', _type: 'component', _component: 'text', body: lang === 'fr' ? '<p>Pliez les genoux.</p>' : '<p>Bend your knees.</p>' },
    { _id: 'c2', _parentId: 'b1', _type: 'component', _component: 'hotgraphic', _graphic: { src: 'course/fr/images/map.png', alt: 'Plan' }, _items: [{ title: 'Ici', body: '<p>Le quai.</p>' }] },
  ];
  const exported = zipOf({
    'package.json': { name: 'adapt_framework' },
    'src/course/config.json': { _defaultLanguage: 'fr' },
    'src/course/en/content.json': items('en'),
    'src/course/fr/content.json': items('fr'),
    'src/course/fr/images/map.png': 'png bytes',
  });

  it('is read from src/, in the language its config names, each item by the type it declares', () => {
    const read = readAnyPackage(filesOfZip(exported), { fileUrl });
    expect(read.title).toBe('Levage');
    expect(read.topics).toEqual([{
      id: 'p1', title: 'Avant', questions: [],
      pages: [{ path: 'src/course/fr/content.json#a1', title: 'A', body: 'Pliez les genoux.\n\n![Plan](https://bridge.example/files/src/course/fr/images/map.png)\n\n**Ici**\n\nLe quai.' }],
    }]);
  });

  it('reads an older export\'s items by the file each is kept in, when they do not say', () => {
    const old = zipOf({
      'course/en/course.json': { _id: 'course', title: 'Old' },
      'course/en/contentObjects.json': [{ _id: 'p', _parentId: 'course', title: 'Page' }],
      'course/en/articles.json': [{ _id: 'a', _parentId: 'p' }],
      'course/en/blocks.json': [{ _id: 'b', _parentId: 'a' }],
      'course/en/components.json': [{ _id: 'c', _parentId: 'b', _component: 'text', body: '<p>Still read.</p>' }],
    });
    const read = adaptPackage(filesOfZip(old), { fileUrl })!;
    expect(read.title).toBe('Old');
    expect(read.topics.map(t => [t.title, t.pages.map(p => p.body)])).toEqual([['Page', ['Still read.']]]);
  });

  it('is not what a package with no Adapt course is', () => {
    expect(adaptPackage(filesOfZip(zipOf({ 'mycourse/en/data.json': { _type: 'page', _id: 'x' }, 'course/en/notes.json': [{ title: 'no types' }] })), { fileUrl })).toBeNull();
  });
});

// ── H5P ─────────────────────────────────────────────────────────────

const column = (...pieces: Array<[string, object]>): object => ({ content: pieces.map(([library, params]) => ({ content: { library, params } })) });
const book = zipOf({
  'h5p.json': { title: 'Plant cells', mainLibrary: 'H5P.InteractiveBook', language: 'en' },
  'content/content.json': {
    chapters: [
      { library: 'H5P.Column 1.16', metadata: { title: 'Parts of a cell' }, params: column(
        ['H5P.AdvancedText 1.1', { text: '<h2>Parts</h2><p>A cell has a <strong>wall</strong>.</p>' }],
        ['H5P.Image 1.1', { file: { path: 'images/cell.png' }, alt: 'A cell' }],
        ['H5P.MultiChoice 1.16', { question: '<p>What surrounds a plant cell?</p>', behaviour: { randomAnswers: false },
          answers: [{ text: '<div>A wall</div>', correct: true }, { text: '<div>A shell</div>', correct: false }, { text: '<div>Fur</div>', correct: false }] }],
        ['H5P.TrueFalse 1.8', { question: '<p>Plant cells have chloroplasts.</p>', correct: 'true' }],
        ['H5P.MultiChoice 1.16', { question: '<p>What is this?</p>', media: { type: { library: 'H5P.Image 1.1', params: {} } }, answers: [{ text: 'x', correct: true }, { text: 'y' }] }],
      ) },
      { library: 'H5P.Column 1.16', metadata: { title: 'What cells do' }, params: column(
        ['H5P.Blanks 1.14', { text: '<p>Fill in the blanks.</p>', questions: ['<p>Leaves make *food* from *light/sunlight:think of the sun*.</p>'] }],
        ['H5P.Video 1.6', { sources: [] }],
        ['H5P.DragText 1.10', { taskDescription: '<p>Drag the words.</p>', textField: 'Roots take in *water*.\nLeaves hold *chlorophyll*.', distractors: '*sand*' }],
        ['H5P.Essay 1.5', { taskDescription: 'Explain photosynthesis.' }],
        ['H5P.Accordion 1.0', { panels: [
          { title: 'Roots', content: { library: 'H5P.AdvancedText 1.1', params: { text: '<p>Roots anchor the plant.</p>' } } },
          { title: 'Quiz', content: { library: 'H5P.TrueFalse 1.8', params: { question: 'Roots make food.', correct: 'false' } } },
        ] }],
      ) },
    ],
  },
  'content/images/cell.png': 'png bytes',
  'H5P.MultiChoice-1.16/library.json': { machineName: 'H5P.MultiChoice' },
});

describe('an interactive book H5P exported', () => {
  const read = h5pPackage(filesOfZip(book), { fileUrl })!;

  it('is read in its own model: each chapter a topic, its text and images a page, its questions its own', () => {
    expect(read.title).toBe('Plant cells');
    expect(read.topics.map(t => [t.id, t.title, t.pages.length, t.questions.length])).toEqual([
      ['chapter-1', 'Parts of a cell', 1, 2],
      ['chapter-2', 'What cells do', 1, 5],
    ]);
    expect(read.topics[0]!.pages).toEqual([{
      path: 'content/content.json#chapters/0/content/0', title: 'Parts of a cell',
      body: '# Parts\n\nA cell has a **wall**.\n\n![A cell](https://bridge.example/files/content/images/cell.png)',
    }]);
    // An accordion panel's title heads what it shows here, and a panel that is a question shows nothing.
    expect(read.topics[1]!.pages[0]!.body).toBe('## Roots\n\nRoots anchor the plant.');
  });

  it('reads each question as the tool marks it right: a blank at a time, a pool of words in alphabetical order', () => {
    expect(read.topics[0]!.questions).toEqual([
      { question: 'What surrounds a plant cell?', type: 'choice', options: ['A wall', 'A shell', 'Fur'], answer: 'A' },
      { question: 'Plant cells have chloroplasts.', type: 'true-false', answer: true },
    ]);
    expect(read.topics[1]!.questions).toEqual([
      { question: 'Fill in the blanks.\n\nLeaves make ____ from ….', type: 'fill-in', answer: 'food', caseSensitive: true },
      { question: 'Fill in the blanks.\n\nLeaves make … from ____.', type: 'fill-in', answer: 'light', accept: ['sunlight'], caseSensitive: true },
      { question: 'Drag the words.\n\nRoots take in ____.', type: 'choice', options: ['chlorophyll', 'sand', 'water'], answer: 'C' },
      { question: 'Drag the words.\n\nLeaves hold ____.', type: 'choice', options: ['chlorophyll', 'sand', 'water'], answer: 'A' },
      { question: 'Roots make food.', type: 'true-false', answer: false },
    ]);
  });

  it('leaves out media, an essay and a question that comes with a picture, and says why', () => {
    expect(read.unread).toEqual([
      { path: 'content/content.json#chapters/0/content/4', why: 'its question comes with an image or a video, which a check here would not show' },
      { path: 'content/content.json#chapters/1/content/1', why: 'H5P.Video: media, which is not text' },
      { path: 'content/content.json#chapters/1/content/3', why: 'H5P.Essay: an answer recorded rather than graded, left for a reflection written here' },
    ]);
  });

  it('folds into checks graded as the tool marks each answer right', () => {
    const [wall, chloroplasts] = checkOf(read, 0);
    expect(questionIsRight('A', wall!)).toBe(true);
    expect(questionIsRight('true', chloroplasts!)).toBe(true);
    const [food, light, water] = checkOf(read, 1);
    expect(questionIsRight('food', food!)).toBe(true);
    expect(questionIsRight('Food', food!)).toBe(false);
    expect(questionIsRight('sunlight', light!)).toBe(true);
    expect(questionIsRight('C', water!)).toBe(true);
    expect(questionIsRight('B', water!)).toBe(false);
  });
});

describe('a presentation H5P content a SCORM package plays', () => {
  const choices = ['Oxygen', 'Nitrogen', 'Carbon', 'Hydrogen', 'Helium', 'Neon'].map((gas, i) => ({
    question: `<p>Question ${i + 1}: which gas is ${gas.toLowerCase()}?</p>`, answers: [`<p>${gas}</p>`, '<p>Argon</p>', '<p>Xenon</p>'],
  }));
  const presentation = zipOf({
    'imsmanifest.xml': MANIFEST, 'index.html': '<html><body><div class="h5p-content"></div><script src="h5p/main.js"></script></body></html>',
    'workspace/h5p.json': { title: 'Gases', mainLibrary: 'H5P.CoursePresentation' },
    'workspace/content/content.json': { presentation: { slides: [
      { elements: [{ action: { library: 'H5P.AdvancedText 1.1', params: { text: '<p>Air is mostly nitrogen.</p>' } } }, { goToSlide: 2 }, { action: { library: 'H5P.Shape 1.0', params: {} } }] },
      { keywords: [{ main: 'Quiz' }], elements: [{ action: { library: 'H5P.SingleChoiceSet 1.11', params: { choices } } }] },
      { elements: [{ action: { library: 'H5P.Summary 1.10', params: { intro: 'Choose the true statement.', summaries: [{ summary: ['<p>Air is mostly nitrogen.</p>', '<p>Air is mostly oxygen.</p>'] }] } } }] },
    ] } },
  });
  const read = readAnyPackage(filesOfZip(presentation), { fileUrl });

  it('is read in H5P\'s model though the package is SCORM: its slides as pages, a way to another slide and a shape as nothing', () => {
    expect(read.title).toBe('Gases');
    expect(read.topics.map(t => [t.id, t.title, t.pages.map(p => [p.path, p.title, p.body]), t.questions.length])).toEqual([
      ['presentation', 'Gases', [['workspace/content/content.json#presentation/slides/0/elements/0', 'Slide 1', 'Air is mostly nitrogen.']], 7],
    ]);
    expect(read.unread).toEqual([]);
  });

  it('turns a right-first list, so its right answer is not always first, the same way every time', () => {
    const asked = read.topics[0]!.questions as Array<Extract<ImportedQuestion, { type: 'choice' }>>;
    const rightTexts = ['Oxygen', 'Nitrogen', 'Carbon', 'Hydrogen', 'Helium', 'Neon', 'Air is mostly nitrogen.'];
    asked.forEach((q, i) => {
      expect(q.options.map(o => o).sort()).toEqual(i < 6 ? [rightTexts[i]!, 'Argon', 'Xenon'].sort() : ['Air is mostly nitrogen.', 'Air is mostly oxygen.']);
      expect(q.options[(q.answer as string).charCodeAt(0) - 65]).toBe(rightTexts[i]);
    });
    expect(new Set(asked.map(q => q.answer)).size).toBeGreaterThan(1);
    expect(readAnyPackage(filesOfZip(presentation), { fileUrl })).toEqual(read);
    expect(asked[6]!.question).toBe('Choose the true statement.');
  });

  it('turns the answers the tool shuffles, and keeps them as they are when its author said not to', () => {
    const one = (behaviour: object): Extract<ImportedQuestion, { type: 'choice' }> => h5pPackage(filesOfZip(zipOf({
      'h5p.json': { title: 'One', mainLibrary: 'H5P.MultiChoice' },
      'content/content.json': { question: 'Which is a noble gas?', behaviour, answers: [{ text: 'Neon', correct: true }, { text: 'Iron' }, { text: 'Salt' }, { text: 'Wood' }] },
    })), { fileUrl })!.topics[0]!.questions[0] as Extract<ImportedQuestion, { type: 'choice' }>;
    const shuffled = one({});
    expect(shuffled.options[(shuffled.answer as string).charCodeAt(0) - 65]).toBe('Neon');
    expect(shuffled.options).not.toEqual(['Neon', 'Iron', 'Salt', 'Wood']);
    expect(one({ randomAnswers: false })).toEqual({ question: 'Which is a noble gas?', type: 'choice', options: ['Neon', 'Iron', 'Salt', 'Wood'], answer: 'A' });
    expect(one({ randomAnswers: false, type: 'multi' })).toMatchObject({ answer: ['A'], multiple: true });
  });

  it('makes a long presentation topics of fifty slides, each fitting a composition', () => {
    const slides = Array.from({ length: 120 }, (_, i) => ({ elements: [{ action: { library: 'H5P.AdvancedText 1.1', params: { text: `<p>Slide text ${i + 1}.</p>` } } }] }));
    const long = h5pPackage(filesOfZip(zipOf({ 'h5p.json': { title: 'Long', mainLibrary: 'H5P.CoursePresentation' }, 'content/content.json': { presentation: { slides } } })), { fileUrl })!;
    expect(long.topics.map(t => [t.id, t.title, t.pages.length])).toEqual([
      ['slides-1-50', 'Long: slides 1 to 50', 50], ['slides-51-100', 'Long: slides 51 to 100', 50], ['slides-101-120', 'Long: slides 101 to 120', 20],
    ]);
    expect(foldPackage(long, { competency: 'long' }).topics.every(t => t.at)).toBe(true);
  });
});

describe('a question graded as its tool grades it (Codex, on #573)', () => {
  const h5p = (params: object, mainLibrary: string): ImportedPackage => h5pPackage(filesOfZip(zipOf({
    'h5p.json': { title: 'One', mainLibrary }, 'content/content.json': params,
  })), { fileUrl })!;

  it('keeps letter case where H5P counts it, reads it without where its author said so, and leaves out a blank that takes misspellings', () => {
    const blanks = (behaviour: object): ImportedPackage => h5p({ text: 'Fill in.', questions: ['<p>The capital is *Paris*.</p>'], behaviour }, 'H5P.Blanks');
    expect(blanks({}).topics[0]!.questions[0]).toMatchObject({ answer: 'Paris', caseSensitive: true });
    expect(blanks({ caseSensitive: false }).topics[0]!.questions[0]).not.toHaveProperty('caseSensitive');
    const typos = blanks({ acceptSpellingErrors: true });
    expect(typos.topics).toEqual([]);
    expect(typos.unread).toEqual([{ path: 'content/content.json#content', why: 'it accepts misspelled answers, which a check here would mark wrong' }]);
    // A flashcard counts it only where its author said so.
    const card = (extra: object): ImportedQuestion => h5p({ cards: [{ text: 'Capital of France?', answer: 'Paris' }], ...extra }, 'H5P.Flashcards').topics[0]!.questions[0]!;
    expect(card({})).toEqual({ question: 'Capital of France?', type: 'fill-in', answer: 'Paris' });
    expect(card({ caseSensitive: true })).toMatchObject({ caseSensitive: true });
  });

  it('reads an escaped slash or colon in a blank as part of its answer', () => {
    const read = h5p({ questions: ['<p>Say *and\\/or*, or *10\\:30/half past ten:a time*.</p>'], behaviour: { caseSensitive: false } }, 'H5P.Blanks');
    expect(read.topics[0]!.questions).toEqual([
      expect.objectContaining({ answer: 'and/or' }),
      expect.objectContaining({ answer: '10:30', accept: ['half past ten'] }),
    ]);
  });

  it('reads a table from its own field', () => {
    const read = h5p({ table: '<table><tr><th>Gas</th><th>Share</th></tr><tr><td>Nitrogen</td><td>78%</td></tr></table>' }, 'H5P.Table');
    expect(read.topics[0]!.pages[0]!.body).toBe('| Gas | Share |\n| --- | --- |\n| Nitrogen | 78% |');
  });

  it('reads an Adapt blank without letter case where its author allows any case', () => {
    const anyCase = adaptPackage(filesOfZip(zipOf({
      'course/en/course.json': { _id: 'course', _type: 'course', title: 'T' },
      'course/en/contentObjects.json': [{ _id: 'p', _parentId: 'course', _type: 'page', title: 'P' }],
      'course/en/articles.json': [{ _id: 'a', _parentId: 'p', _type: 'article' }],
      'course/en/blocks.json': [{ _id: 'b', _parentId: 'a', _type: 'block' }],
      'course/en/components.json': [{ _id: 'c', _parentId: 'b', _type: 'component', _component: 'textinput', body: 'Capital?', _allowsAnyCase: true, _items: [{ _answers: ['Paris'] }] }],
    })), { fileUrl })!;
    expect(anyCase.topics[0]!.questions).toEqual([{ question: 'Capital?\n\n____', type: 'fill-in', answer: 'Paris' }]);
  });
});

describe('a package no tool here models', () => {
  it('is read as any package is, its pages and the banks it declares', () => {
    const plain = zipOf({
      'imsmanifest.xml': '<?xml version="1.0"?><manifest identifier="m"><organizations default="o"><organization identifier="o"><title>Plain</title><item identifier="i" identifierref="r"><title>Page</title></item></organization></organizations>'
        + '<resources><resource identifier="r" type="webcontent" href="lesson/page.html"><file href="lesson/page.html"/></resource></resources></manifest>',
      'lesson/page.html': '<html><head><title>Page</title></head><body><h1>Page</h1><p>Words of its own.</p></body></html>',
    });
    const read = readAnyPackage(filesOfZip(plain), { fileUrl });
    expect(read.title).toBe('Plain');
    expect(read.topics.map(t => [t.id, t.pages.map(p => p.body)])).toEqual([['lesson', ['Words of its own.']]]);
  });

  it('is refused, as before, when it is no package at all', () => {
    expect(() => readAnyPackage(filesOfZip(zipOf({ 'readme.txt': 'hello' })), { fileUrl })).toThrow(PackageError);
  });
});
