/**
 * A COURSE CAPTIVATE PUBLISHED IS READ IN CAPTIVATE'S OWN MODEL.
 *
 * A package Captivate published is a player page its runtime draws each slide into, so read as web
 * pages it has nothing to fold. The course is one JavaScript object literal the player assigns
 * (captivate-course.ts): in assets/js/CPM.js beside the Classic runtime (Captivate 8 to 11), in
 * assets/js/project.js for the new player (12.4 and later). project.txt names the generator. The
 * fixtures here are made up, and shaped as real exports are.
 *
 * Here: the slides as pages, each item in the order the slide shows it (a fixed Classic project's
 * accessibility text, a responsive one's HTML, the new player's rich text), their pictures and
 * their narration's captions; what is not text left out with why; each kind of question right as
 * Captivate grades it, Classic and new; the literal read without running it; the layouts Captivate
 * publishes; and each read folded and graded.
 */
import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { filesOfZip, foldPackage, type ImportedPackage, type ImportedQuestion } from '../src/package-import.js';
import { captivatePackage } from '../src/captivate-course.js';
import { literalAt } from '../src/tool-reading.js';
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

const REF = Symbol('a runtime handler');
/** A runtime handler the literal names (`cp.fd`), which it holds as a name. */
const handler = (name: string): object => ({ [REF]: name });
/** A value as Captivate writes one in its data file: bare keys, single-quoted strings, a handler by name. */
const lit = (v: unknown): string => {
  if (v === null) return 'null';
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(lit).join(',')}]`;
  const o = v as Record<string | symbol, unknown>;
  if (typeof o[REF] === 'string') return o[REF] as string;
  return `{${Object.entries(o).map(([k, x]) => `${/^(?:\d+|[A-Za-z_$][\w$]*)$/.test(k) ? k : lit(k)}:${lit(x)}`).join(',')}}`;
};
/** A data file as Captivate writes one: the player's prologue, the course's literal, and what follows it. */
const dataFile = (D: object, after = ''): string =>
  `if(!window.cp)window.cp = function(str){return document.getElementById(str)};cp.CPProjInit = function(){if(cp && cp.model && cp.model.data) return; cp.model = {}; cp.poolResources = {}; cp.D = cp.model.data = ${lit(D)};${after}};`;
const projectTxt = (version: string, title = ''): string => JSON.stringify({ metadata: { generator: 'Captivate', generatorVersion: version, title, responsive: false } });

type Items = Record<string, object>;
interface Slide { key: string; items: Items }
/** What a fixed Classic caption keeps between its paragraphs, for a screen reader. */
const P = String.fromCharCode(3);
/** A Classic item and its display object: when it appears, where it is, and what it keeps for a screen reader. */
const item = (key: string, type: number, from: number, [left, top]: [number, number], display: object = {}, own: object = {}): Items => ({
  [key]: { type, from, to: 90, mdi: `${key}c`, ...own },
  [`${key}c`]: { b: [left, top, left + 500, top + 60], sr: handler('cp.fd'), ip: `dr/${key}.png`, visible: 1, ...display },
});
/** A caption: a fixed project draws it as a picture, and keeps its text for a screen reader. */
const caption = (key: string, top: number, ...paras: string[]): Items => item(key, 19, 1, [40, top], { accstr: `${paras.join(P)} ` });
const slide = (key: string, lb: string, si: Array<[string, number]>, items: Items, own: object = {}): Slide => ({
  key, items: { [key]: { lb, st: 'Normal Slide', from: 1, to: 90, si: si.map(([n, t]) => ({ n, t })), qs: '', ...own }, ...items },
});
/** A Classic question slide: its question's text on the slide, and the question as Captivate keeps it. */
const ask = (key: string, text: string, q: object, more: Items = {}): Slide => ({
  key,
  items: {
    [key]: { lb: '', st: 'Question Slide', from: 1, to: 90, si: [{ n: `${key}_Question`, t: 79 }], qs: `${key}q0` },
    ...item(`${key}_Question`, 79, 1, [40, 40], { accstr: `${text} ` }),
    // `qt` is a copy Captivate does not keep in step with the slide.
    [`${key}q0`]: { it: true, w: 10, nw: 0, sra: false, qtc: `${key}_Questionc`, qt: 'An old copy of the question', ...q },
    ...more,
  },
});
/** A Classic question's answers: each its letter, its text, and whether Captivate marks it correct. */
const answers = (key: string, at: number, ...cs: Array<[string, boolean?]>): { ao: string[]; items: Items } => {
  const items: Items = {};
  const ao = cs.map(([text, right], i) => {
    items[`${key}_Answer${i}c`] = { aid: String.fromCharCode(65 + i), at, ...(text ? { atxtlms: text, accstr: `${text} ` } : {}), ...(right ? { ic: true } : {}) };
    return `${key}_Answer${i}c:0`;
  });
  return { ao, items };
};
const course = (slides: Slide[], main: object = {}): object => ({
  pref: { acc: 1 },
  project_main: { slides: slides.map(s => s.key).join(','), useResponsive: false, ...main },
  project: { w: 1024, h: 627, pN: 'Fire_safety.cptx' },
  ...Object.assign({}, ...slides.map(s => s.items)),
});

const extinguisher = answers('Slide4', 10082, ['Carbon dioxide', true], ['Water'], ['Foam'], ['Wet chemical']);
const triangle = answers('Slide5', 10081, ['Heat'], ['Fuel'], ['Water'], ['Oxygen']);
const lift = answers('Slide6', 10082, ['True'], ['False', true]);
const pictured = answers('Slide17', 10082, ['An exit', true], ['']);
const unmarked = answers('Slide18', 10082, ['This'], ['That']);
const exits = answers('Slide22', 10081, ['A door', true], ['A lift']);
const CLASSIC_SLIDES: Slide[] = [
  // Listed in layer order; read by when each item appears, then top to bottom. A state's copy, a
  // button and a shape used as one are not the slide's text; a caption drawn as a picture is no picture.
  slide('Slide1', 'Know your exits', [['Text_Caption_2', 19], ['Image_3', 15], ['Text_Caption_1', 19], ['Button_4', 177], ['Text_Caption_2_Rollover', 19], ['SmartShape_5', 612], ['Image_6', 15]], {
    ...caption('Text_Caption_1', 20, 'Hello $$v_name$$, every building has two ways out.'),
    ...caption('Text_Caption_2', 300, 'Walk each route once.', 'Keep doors clear.'),
    ...item('Image_3', 15, 30, [620, 100], { ip: 'dr/exit_280_300.png', accstr: 'A lit exit sign ' }),
    ...item('Button_4', 177, 1, [40, 500], { accstr: 'Continue ' }),
    ...item('Text_Caption_2_Rollover', 19, 1, [40, 300], { accstr: 'Walk each route once. ' }, { bstin: 'Text_Caption_2' }),
    ...item('SmartShape_5', 612, 1, [40, 560], { accstr: 'Next ' }, { uab: 1 }),
    // Packed into dr/img1.json, as Classic packs pictures from 9.0.
    ...item('Image_6', 15, 1, [700, 450], { ip: 'dr/logo_120_60.png', accstr: 'Image ' }),
  }),
  // Narration with captions; then narration without, a video and a web object.
  slide('Slide2', 'Smoke', [['Text_Caption_7', 19], ['Image_11', 15]], {
    ...caption('Text_Caption_7', 40, 'Stay under the smoke.'),
    // "Image" is the alt text Captivate gives a picture no one described.
    ...item('Image_11', 15, 1, [40, 200], { ip: 'dr/door_200_300.png', accstr: 'Image ' }),
  }, {
    from: 91, to: 180, audCC: [{ sf: 1, ef: 40, t: { 1024: '<div><span class="cp-actualText">Smoke rises, so stay low.</span></div>' } }],
  }),
  slide('Slide3', 'Watch', [['Text_Caption_8', 19], ['Video_9', 98], ['Web_10', 652], ['Image_12', 15]], {
    ...caption('Text_Caption_8', 40, 'Watch the drill.'),
    ...item('Image_12', 15, 1, [40, 500], { ip: 'dr/drill_shot.png', accstr: 'drill_shot.png ' }),
    ...item('Video_9', 98, 1, [40, 120], { mp4: 'vr/drill.mp4' }),
    ...item('Web_10', 652, 1, [40, 400], { wou: 'https://example.org' }),
  }, { from: 181, to: 270 }),
  // Shuffled (`sra`): turned, so the right one is not always first. Right as its answers are marked.
  ask('Slide4', 'Which extinguisher is safe on an electrical fire?', { itp: 'choice', qtp: 'MCQ', ao: extinguisher.ao, cal: [], sra: true }, extinguisher.items),
  // Several right, named by the list the question keeps.
  ask('Slide5', 'Which make up the fire triangle?', { itp: 'choice', qtp: 'MCQ', ao: triangle.ao, cal: ['A', 'B', 'D'] }, triangle.items),
  ask('Slide6', 'You should use a lift in a fire.', { itp: 'true-false', qtp: 'MCQ', ao: lift.ao, cal: ['B'] }, lift.items),
  // A blank in a phrase, which keeps the word "dash" where the blank is.
  ask('Slide7', 'Complete the sentence.', { itp: 'fill-in', qtp: 'FIB', ao: ['Slide7_q1_answer_0_mcfib'], cal: [] }, {
    Slide7_q1_answer_0_mcfib: { aid: '1', correctAnswers: ['999', '112'], allAnswers: ['999', '112'], cs: true, sac: false, capN: 'Slide7_Phrase' },
    ...item('Slide7_Phrase', 10106, 1, [40, 200], { fibText: 'Get out, stay out, and call dash. ', accstr: 'Get out, stay out, and call 999. ' }),
  }),
  // A blank that is a list to choose from.
  ask('Slide8', 'Choose the right word.', { itp: 'fill-in', qtp: 'FIB', ao: ['Slide8_q1_answer_0_mcfib'], cal: [] }, {
    Slide8_q1_answer_0_mcfib: { aid: '1', correctAnswers: ['low'], allAnswers: ['high', 'low'], cs: false, sac: true, capN: 'Slide8_Phrase' },
    ...item('Slide8_Phrase', 10106, 1, [40, 200], { fibText: 'Smoke rises, so stay dash. ' }),
  }),
  ask('Slide9', 'What do you pull first on an extinguisher?', { itp: 'long-fill-in', qtp: 'ShortAnswer', cal: ['the pin', 'pin'], ao: ['Slide9_Answersha'] }, { Slide9_Answersha: { cs: false } }),
  ask('Slide10', 'Which gas does a fire need? (a chemical symbol)', { itp: 'long-fill-in', qtp: 'ShortAnswer', cal: ['O2'], ao: ['Slide10_Answersha'] }, { Slide10_Answersha: { cs: true } }),
  ask('Slide11', 'Describe your escape route.', { itp: 'long-fill-in', qtp: 'ShortAnswer', cal: [''], ao: ['Slide11_Answersha'] }, { Slide11_Answersha: { cs: false } }),
  // Column 1's aid is the letter of the entry in column 2 it matches.
  ask('Slide12', 'Match each class of fire to its fuel.', { itp: 'matching', qtp: 'Matching', cal: [], aio: ['Slide12_Left0c:35:157', 'Slide12_Left1c:35:200'], aco: ['Slide12_Right0c', 'Slide12_Right1c'] }, {
    Slide12_Left0c: { aid: 'B', aAnsTxtlms: 'Class A' }, Slide12_Left1c: { aid: 'A', aAnsTxtlms: 'Class B' },
    Slide12_Right0c: { aid: 'A', atxtlms: 'Flammable liquids' }, Slide12_Right1c: { aid: 'B', atxtlms: 'Wood and paper' },
  }),
  // Shown in one order; its correct order names each by its id.
  ask('Slide13', 'Put the steps in order.', { itp: 'sequencing', qtp: 'Sequence', ao: ['Slide13_A0c:0', 'Slide13_A1c:0', 'Slide13_A2c:0', 'Slide13_A3c:0'], cal: ['1', '2', '3', '4'] }, {
    Slide13_A0c: { aid: '3', atxtlms: 'Squeeze the handle' }, Slide13_A1c: { aid: '1', atxtlms: 'Pull the pin' },
    Slide13_A2c: { aid: '4', atxtlms: 'Sweep side to side' }, Slide13_A3c: { aid: '2', atxtlms: 'Aim at the base' },
  }),
  ask('Slide14', 'Click the exit.', { itp: 'hotspot', qtp: 'Hotspot', ao: ['Slide14_1hotspot'], cal: ['1'] }, { Slide14_1hotspot: { b: [1, 1, 2, 2], aid: '1', ic: true } }),
  ask('Slide15', 'Rate this course.', { itp: 'likert', qtp: 'Likert' }),
  ask('Slide16', 'How was this course?', { itp: 'choice', qtp: 'MCQ', is: true, ao: lift.ao }),
  ask('Slide17', 'Which is the exit sign?', { itp: 'choice', qtp: 'MCQ', ao: pictured.ao, cal: ['A'] }, pictured.items),
  ask('Slide18', 'Pick one.', { itp: 'choice', qtp: 'MCQ', ao: unmarked.ao, cal: [] }, unmarked.items),
  // Objects on a normal slide scored as questions: a click on each alarm point.
  slide('Slide19', 'Find the alarm', [['Text_Caption_20', 19], ['SmartShape_21', 612]], {
    ...caption('Text_Caption_20', 40, 'Click each alarm point.'),
    ...item('SmartShape_21', 612, 1, [40, 200], { accstr: 'Alarm point ' }),
    Slide19_Clickq0: { it: true, itp: 'choice', qtp: 'InteractiveItemQuestion', w: 10, cal: '', ao: '' },
    Slide19_Click2q1: { it: true, itp: 'choice', qtp: 'InteractiveItemQuestion', w: 10, cal: '', ao: '' },
  }, { qs: 'Slide19_Clickq0,Slide19_Click2q1' }),
  slide('Slide20', 'Results', [['Results_22', 111], ['Text_Caption_23', 19]], { ...item('Results_22', 111, 1, [40, 40]), ...caption('Text_Caption_23', 200, 'You scored $$cpQuizInfoPointsscored$$.') }),
  ask('Slide21', 'Try it.', { itp: 'other', qtp: 'RandomQuestion' }),
  // Several answers allowed (a checkbox each), one of them right.
  ask('Slide22', 'Which of these is a way out? (Pick all that apply)', { itp: 'choice', qtp: 'MCQ', ao: exits.ao, cal: ['A'] }, exits.items),
  ask('Slide23', 'Complete both.', { itp: 'fill-in', qtp: 'FIB', ao: ['Slide23_q1_answer_0_mcfib', 'Slide23_q1_answer_1_mcfib'], cal: [] }, {
    Slide23_q1_answer_0_mcfib: { aid: '1', correctAnswers: ['out'], cs: false, sac: false, capN: 'Slide23_Phrase' },
    Slide23_q1_answer_1_mcfib: { aid: '2', correctAnswers: ['out'], cs: false, sac: false, capN: 'Slide23_Phrase' },
    ...item('Slide23_Phrase', 10106, 1, [40, 200], { fibText: 'Get dash and stay dash. ' }),
  }),
];
const CLASSIC = course(CLASSIC_SLIDES);
const AUDIO = 'cp.model.audios={};';
const AFTER = `cp.cv('cpInfoProjectName','Sample: Fire safety',1,15,0);${AUDIO}`;
const CLASSIC_FILES = (root = '', data = dataFile({ ...CLASSIC, StAd1: { from: 95, to: 170, src: 'ar/1.mp3', du: 2.5 }, StAd2: { from: 190, to: 260, src: 'ar/2.mp3', du: 2.3 } }, AFTER)): Record<string, string | Buffer> => ({
  [`${root}index.html`]: "<!DOCTYPE html><html><head><title>Fire safety (launch page)</title><script src='assets/js/CPXHRLoader.js'></script></head><body><div id='cpDocument'></div><script>cpXHRJSLoader.js(['assets/js/CPM.js'],function(){cp.DoCPInit();});</script></body></html>",
  [`${root}project.txt`]: projectTxt('11.8.2'),
  [`${root}assets/js/CPM.js`]: data,
  [`${root}dr/exit_280_300.png`]: 'png', [`${root}dr/door_200_300.png`]: 'png', [`${root}dr/drill_shot.png`]: 'png',
  [`${root}dr/img1.json`]: 'cp.imagesJSONCache001={"dr/logo_120_60.png":"iVBORw0KGgo=","___":"___"};',
  [`${root}ar/1.mp3`]: 'mp3',
});

/** Rich text as the new player keeps it: Draft.js, as a JSON string. */
const draft = (...blocks: Array<string | { text: string; type: string }>): string =>
  JSON.stringify({ blocks: blocks.map(b => (typeof b === 'string' ? { key: 'k', text: b, type: 'unstyled' } : { key: 'k', ...b })), entityMap: {} });
const text = (tag: string, ...blocks: Array<string | { text: string; type: string }>): object => ({ type: 1250, tag, text: draft(...blocks) });
const choiceOf = (tag: string, label: string, ic = false, picture = false): object => ({
  type: 10090, tag, ic, widgetProps: JSON.stringify({ normal: { editorState: { blocks: [{ text: label, type: 'unstyled' }] } }, isImageActive: picture }),
});
const listOf = (tag: string, dca: number): object => ({ type: 10189, tag, dca, widgetProps: JSON.stringify({ selected: { container: { options: ['Through the mouth', 'Through the nose'] } } }) });
/** A slide of the new player (its frames after the one before's): a container holding its items. */
let frame = 0;
const nested = (key: string, lb: string, type: number, items: Record<string, object>, own: object = {}, twice: string[] = []): Items => ({
  [key]: { lb, type, from: (frame += 100) - 99, to: frame - 10, si: [{ n: `${key}_root`, t: 1268 }], qs: type === 77 ? `${key}q0` : '', ...own },
  [`${key}_root`]: { type: 1268, si: [...Object.keys(items), ...twice].map(n => ({ n, t: (items[n] as { type: number }).type })) },
  ...items,
});
const NEW = {
  pref: { acc: 1, lang: '' },
  project_main: { slides: 'Slide100,Slide200,Slide300,Slide400,Slide500,Slide600,Slide700', featureFlags: { isNewWidgetArchitecture: true } },
  project: { w: 1366, h: 768, pN: 'Breathing.cpt' },
  ...nested('Slide100', 'Box breathing', 30, {
    si102: text('slide-item-heading', { text: 'Four counts each', type: 'header-one' }),
    si103: text('slide-item-body', { text: 'In for four.', type: 'ordered-list-item' }, { text: 'Hold for four.', type: 'ordered-list-item' }, 'Well done, @#{101}.'),
    si104: { type: 15, tag: 'slide-item-image', mdi: 'si104c' },
    si105: text('slide-item-next-button', 'Next'),
  }, { audCC: `"${JSON.stringify([{ start: 0, editorState: { blocks: [{ key: 'c', text: 'Breathe with me.', type: 'unstyled' }] } }])}"` }, ['si102']),
  si104c: { b: [700, 100, 1200, 600], ip: 'dr/1.png' },
  ...nested('Slide200', 'Check', 77, {
    si202: text('slide-item-question-text', 'How long is each count?'),
    si203: choiceOf('slide-item-answer-checkbox1', 'One second'),
    // Right as the question names it (`cal`), not marked on the choice.
    si204: choiceOf('slide-item-answer-checkbox2', 'Four seconds'),
    si205: choiceOf('slide-item-answer-checkbox3', 'Ten seconds'),
    si206: text('slide-item-submit-button', 'Submit'),
  }),
  Slide200q0: { itp: 'choice', qtp: 'MCQ', ail: ['si203', 'si204', 'si205'], cal: ['si204'], sra: false, qt: '' },
  ...nested('Slide300', 'Match', 77, {
    si302: text('slide-item-question-text', 'Match each breath to how you take it.'),
    si303: text('slide-item-question-text1', 'Inhale'),
    si304: text('slide-item-question-text2', 'Exhale'),
    si305: listOf('slide-item-answer-dropdown1', 1),
    si306: listOf('slide-item-answer-dropdown2', 0),
  }),
  Slide300q0: { itp: 'matching', qtp: 'Matching', cal: [] },
  // Its items in their correct order, whatever order the slide lists them in.
  ...nested('Slide400', 'Order', 77, {
    si402: text('slide-item-question-text', 'Put the steps in order.'),
    si403: text('slide-item-answer-text2', 'Hold'),
    si404: text('slide-item-answer-text1', 'Breathe in'),
    si405: text('slide-item-answer-text3', 'Breathe out'),
  }),
  Slide400q0: { itp: 'sequencing', qtp: 'Sequence' },
  // Its answers are the field's own list; the item's `ifal` is a stale default.
  ...nested('Slide500', 'Count', 77, {
    si502: text('slide-item-question-text', 'How many counts is each side of the box?'),
    si503: { type: 10094, tag: 'slide-item-answer-inputfield', ifal: ['stale'], widgetProps: JSON.stringify({ inputFieldProps: { answersList: ['Four', '4'], enableCaseSensitive: true } }) },
  }),
  Slide500q0: { itp: 'long-fill-in', qtp: 'ShortAnswer' },
  ...nested('Slide600', 'Results', 102, {}),
  ...nested('Slide700', 'Signs', 77, {
    si702: text('slide-item-question-text', 'Which sign means stop?'),
    si703: choiceOf('slide-item-answer-checkbox1', 'Stop sign', true, true),
    si704: choiceOf('slide-item-answer-checkbox2', 'Go sign'),
  }),
  Slide700q0: { itp: 'choice', qtp: 'MCQ', ail: ['si703', 'si704'], cal: ['si703'] },
  StAd1: { from: 1, to: 80, src: 'ar/1.mp3', du: 2.6, saup: [{ sn: 'Slide100' }] },
};
const NEW_FILES = (root = ''): Record<string, string | Buffer> => ({
  [`${root}index.html`]: '<!DOCTYPE html><html><head><title>Sample: Breathing</title></head><body><div id="app"></div><script src="assets/js/project.js"></script><script src="dist/main.chunk.js"></script></body></html>',
  [`${root}project.txt`]: JSON.stringify({ metadata: { generator: 'Captivate', generatorVersion: '12.6.0', responsive: true } }),
  [`${root}assets/js/project.js`]: `if(!window.cp)window.cp = function(str){return document.getElementById(str)};cp.CPProjInit = function(){if(cp && cp.model && cp.model.data) return; cp.model = {}; cp.poolResources = {}; cp.poolSlideResources = {};cp.D = cp.model.data = ${lit(NEW).replace(/,(?=[A-Za-z_$][\w$]*:)/g, ',\n')};cp.model.data.images=[];};`,
  [`${root}dr/1.png`]: 'png',
});

/** Each question of a folded topic's check, as the engine stores it. */
const checkOf = (pkg: ImportedPackage, topic: number): ScormAssessmentQuestion[] => {
  const folded = foldPackage(pkg, { competency: 'fire-safety', blindFor: () => '0'.repeat(64) });
  const check = folded.items.find(i => i['@id'] === folded.topics[topic]!.check) as Fragment;
  return (check.questions ?? []) as ScormAssessmentQuestion[];
};
const letterOf = (q: ImportedQuestion, option: string): string => String.fromCharCode(65 + (q as Extract<ImportedQuestion, { type: 'choice' }>).options.indexOf(option));
const at = (slide: string): string => `assets/js/CPM.js#${slide}`;

describe('a course Captivate Classic published, its text kept for a screen reader', () => {
  const read = captivatePackage(filesOfZip(zipOf(CLASSIC_FILES())), { fileUrl })!;

  it('is read in its own model: a topic of its slides, titled by the project', () => {
    expect(read.title).toBe('Sample: Fire safety');
    expect(read.topics.map(t => [t.title, t.pages.length, t.questions.length])).toEqual([['Sample: Fire safety', 4, 10]]);
  });

  it('makes each slide a page: its items in the order it shows them, its pictures, its narration\'s captions', () => {
    expect(read.topics[0]!.pages).toEqual([
      {
        path: at('Slide1'), title: 'Know your exits',
        body: 'Hello …, every building has two ways out.\n\nWalk each route once.\n\nKeep doors clear.\n\n![A lit exit sign](https://bridge.example/files/dr/exit_280_300.png)',
      },
      // A picture's alt text is what describes it: not Captivate's default, nor its file's name.
      { path: at('Slide2'), title: 'Smoke', body: 'Stay under the smoke.\n\n![](https://bridge.example/files/dr/door_200_300.png)\n\n# Narration\n\nSmoke rises, so stay low.' },
      { path: at('Slide3'), title: 'Watch', body: 'Watch the drill.\n\n![](https://bridge.example/files/dr/drill_shot.png)' },
      { path: at('Slide19'), title: 'Find the alarm', body: 'Click each alarm point.\n\nAlarm point' },
    ]);
  });

  it('reads each question as Captivate grades it, its text from the slide', () => {
    const [shuffled, ...rest] = read.topics[0]!.questions;
    // Shuffled (`sra`): turned, so the right one is not always first.
    const shown = shuffled as Extract<ImportedQuestion, { type: 'choice' }>;
    expect(shown.question).toBe('Which extinguisher is safe on an electrical fire?');
    expect([...shown.options].sort()).toEqual(['Carbon dioxide', 'Foam', 'Water', 'Wet chemical']);
    expect(shown.options[0]).not.toBe('Carbon dioxide');
    expect(shown.answer).toBe(letterOf(shuffled!, 'Carbon dioxide'));
    expect(rest).toEqual([
      { question: 'Which make up the fire triangle?', type: 'choice', options: ['Heat', 'Fuel', 'Water', 'Oxygen'], answer: ['A', 'B', 'D'], multiple: true },
      { question: 'You should use a lift in a fire.', type: 'choice', options: ['True', 'False'], answer: 'B' },
      { question: 'Complete the sentence.\n\nGet out, stay out, and call ____.', type: 'fill-in', answer: '999', accept: ['112'], caseSensitive: true, compare: 'exact' },
      { question: 'Choose the right word.\n\nSmoke rises, so stay ____.', type: 'choice', options: ['high', 'low'], answer: 'B' },
      { question: 'What do you pull first on an extinguisher?', type: 'fill-in', answer: 'the pin', accept: ['pin'], compare: 'exact' },
      { question: 'Which gas does a fire need? (a chemical symbol)', type: 'fill-in', answer: 'O2', caseSensitive: true, compare: 'exact' },
      { question: 'Match each class of fire to its fuel.', type: 'matching', pairs: [['Class A', 'Wood and paper'], ['Class B', 'Flammable liquids']] },
      { question: 'Put the steps in order.', type: 'sequencing', items: ['Pull the pin', 'Aim at the base', 'Squeeze the handle', 'Sweep side to side'] },
      { question: 'Which of these is a way out? (Pick all that apply)', type: 'choice', options: ['A door', 'A lift'], answer: ['A'], multiple: true },
    ]);
  });

  it('leaves out what is not text or a question it could ask, and says why', () => {
    expect(read.unread).toEqual([
      { path: at('Slide3'), why: 'a video, which is not text' },
      { path: at('Slide3'), why: 'a web object, which is not read' },
      { path: at('Slide11'), why: 'it lists no answer, so any reply is right' },
      { path: at('Slide14'), why: 'a hotspot question, which a check here would not show' },
      { path: at('Slide15'), why: 'a survey question, which grades nothing' },
      { path: at('Slide16'), why: 'a survey question, which grades nothing' },
      { path: at('Slide17'), why: 'a choice is a picture, which a check here would not show' },
      { path: at('Slide18'), why: 'it marks no answer correct' },
      { path: at('Slide19'), why: '2 objects scored as questions (a click or a drag), which are not read' },
      { path: at('Slide20'), why: "a quiz's results slide: the score it shows is a running course's" },
      { path: at('Slide21'), why: 'a question of the kind "other", which is not read' },
      { path: at('Slide23'), why: 'it has several blanks, and a question here asks one' },
      { path: 'assets/js/CPM.js', why: 'narration on one slide, with no captions, which is not text' },
      { path: 'assets/js/CPM.js', why: "a picture packed into the player's data files (dr/img*.json), which are not served" },
    ]);
  });

  it('folds into checks graded as Captivate grades them', () => {
    const [fire, triangle, lift, call, stay, pin, gas, classes, steps, exits] = checkOf(read, 0);
    const qs = read.topics[0]!.questions;
    expect(questionIsRight(letterOf(qs[0]!, 'Carbon dioxide'), fire!)).toBe(true);
    expect(questionIsRight(letterOf(qs[0]!, 'Water'), fire!)).toBe(false);
    expect(questionIsRight('A, B, D', triangle!)).toBe(true);
    expect(questionIsRight('A, B', triangle!)).toBe(false);
    expect(questionIsRight('B', lift!)).toBe(true);
    expect(questionIsRight('112', call!)).toBe(true);
    expect(questionIsRight('911', call!)).toBe(false);
    expect(questionIsRight('B', stay!)).toBe(true);
    expect(questionIsRight('The Pin', pin!)).toBe(true);
    expect(questionIsRight('the pin!', pin!)).toBe(false);
    expect(questionIsRight('O2', gas!)).toBe(true);
    expect(questionIsRight('o2', gas!)).toBe(false);
    const targets = (classes as ScormAssessmentQuestion & { input: { targets: string[] } }).input.targets;
    expect(questionIsRight(['Wood and paper', 'Flammable liquids'].map(t => String.fromCharCode(65 + targets.indexOf(t))).join(', '), classes!)).toBe(true);
    const order = (steps as ScormAssessmentQuestion & { input: { items: string[] } }).input.items;
    expect(questionIsRight(['Pull the pin', 'Aim at the base', 'Squeeze the handle', 'Sweep side to side'].map(t => String.fromCharCode(65 + order.indexOf(t))).join(', '), steps!)).toBe(true);
    expect(questionIsRight('A', exits!)).toBe(true);
    expect(questionIsRight('A, B', exits!)).toBe(false);
  });

  it('is what the fold reads a hosted package as, and one published for the web is kept as an export', () => {
    expect(readAnyPackage(filesOfZip(zipOf(CLASSIC_FILES())), { fileUrl })).toEqual(read);
    expect(projectExportOf(zipOf(CLASSIC_FILES()).toBuffer())).toMatchObject({ tool: 'Captivate', title: 'Sample: Fire safety' });
  });
});

describe('a responsive Classic project, its text kept as HTML', () => {
  it('reads each item\'s HTML, and a width\'s own where the item keeps no other', () => {
    const slides: Slide[] = [slide('Slide1', 'Fire triangle', [['Text_Caption_1', 19], ['Text_Caption_2', 19]], {
      ...item('Text_Caption_1', 19, 1, [40, 20], {}, { vt: '<div><span class="cp-actualText">Heat, fuel and oxygen.</span></div><div><span class="cp-actualText">Take one away.</span></div>' }),
      ...item('Text_Caption_2', 19, 1, [40, 200], {}, { rpvt: { 1024: { vt: '<div><span class="cp-actualText">The fire goes out.</span></div>', text: 'The fire goes out.' } } }),
    })];
    const zip = zipOf({ 'assets/js/CPM.js': dataFile(course(slides, { useResponsive: true })), 'project.txt': projectTxt('11.5.5', 'Sample: Triangle') });
    const read = captivatePackage(filesOfZip(zip), { fileUrl })!;
    expect(read.title).toBe('Sample: Triangle');
    expect(read.topics[0]!.pages).toEqual([{ path: at('Slide1'), title: 'Fire triangle', body: 'Heat, fuel and oxygen.\n\nTake one away.\n\nThe fire goes out.' }]);
  });
});

describe('a course the new Captivate published', () => {
  const read = captivatePackage(filesOfZip(zipOf(NEW_FILES())), { fileUrl })!;
  const where = (slide: string): string => `assets/js/project.js#${slide}`;

  it('makes each slide a page of its rich text, as its containers nest it, with its pictures and its captions', () => {
    expect(read.title).toBe('Sample: Breathing');
    expect(read.topics[0]!.pages).toEqual([{
      path: where('Slide100'), title: 'Box breathing',
      body: '# Four counts each\n\n1. In for four.\n2. Hold for four.\n\nWell done, ….\n\n![](https://bridge.example/files/dr/1.png)\n\n# Narration\n\nBreathe with me.',
    }]);
  });

  it('reads each question as the new player grades it', () => {
    expect(read.topics[0]!.questions).toEqual([
      { question: 'How long is each count?', type: 'choice', options: ['One second', 'Four seconds', 'Ten seconds'], answer: 'B' },
      { question: 'Match each breath to how you take it.', type: 'matching', pairs: [['Inhale', 'Through the nose'], ['Exhale', 'Through the mouth']] },
      { question: 'Put the steps in order.', type: 'sequencing', items: ['Breathe in', 'Hold', 'Breathe out'] },
      { question: 'How many counts is each side of the box?', type: 'fill-in', answer: 'Four', accept: ['4'], caseSensitive: true, compare: 'exact' },
    ]);
    expect(read.unread).toEqual([
      { path: where('Slide600'), why: "a quiz's results slide: the score it shows is a running course's" },
      { path: where('Slide700'), why: 'a choice is a picture, which a check here would not show' },
    ]);
  });

  it('is kept as an export when published for the web or xAPI, in a folder of its own', () => {
    const zip = zipOf({ ...NEW_FILES('Breathing/'), 'Breathing/tincan.xml': '<tincan/>' });
    const inFolder = captivatePackage(filesOfZip(zip), { fileUrl })!;
    expect(inFolder.topics[0]!.pages[0]!.path).toBe('Breathing/assets/js/project.js#Slide100');
    expect(inFolder.topics[0]!.pages[0]!.body).toContain('(https://bridge.example/files/Breathing/dr/1.png)');
    expect(projectExportOf(zip.toBuffer())).toMatchObject({ tool: 'Captivate', title: 'Sample: Breathing' });
    expect(readAnyPackage(filesOfZip(zip), { fileUrl })).toEqual(inFolder);
  });
});

describe('the other ways Captivate publishes a course', () => {
  it('reads a SCORM package, and plays it as one', () => {
    const { 'index.html': _web, ...rest } = CLASSIC_FILES();
    const scorm = zipOf({ ...rest, 'imsmanifest.xml': '<manifest identifier="i"><organizations/><resources><resource identifier="r" href="index_scorm.html"/></resources></manifest>', 'index_scorm.html': '<html><head><title>Fire safety</title></head><body onload="Start()"></body></html>' });
    expect(captivatePackage(filesOfZip(scorm), { fileUrl })!.topics[0]!.questions).toHaveLength(10);
    expect(projectExportOf(scorm.toBuffer())).toBeNull();
  });

  it('reads each course in a zip of several, Classic and new', () => {
    const read = readAnyPackage(filesOfZip(zipOf({ ...CLASSIC_FILES('fire/'), ...NEW_FILES('breathing/') })), { fileUrl, title: 'Two courses' });
    expect(read.title).toBe('Two courses');
    expect(read.topics.map(t => [t.id, t.title, t.pages.length, t.questions.length])).toEqual([
      ['breathing/slides', 'Sample: Breathing', 1, 4],
      ['fire/slides', 'Sample: Fire safety', 4, 10],
    ]);
  });

  it('titles the course by its project, else its launch page, else its file', () => {
    const titled = (files: Record<string, string>): string => captivatePackage(filesOfZip(zipOf(files)), { fileUrl })!.title;
    const one = course([slide('Slide1', 'One', [['Text_Caption_1', 19]], caption('Text_Caption_1', 20, 'Words.'))]);
    // The project's name as the player sets it, its escapes decoded.
    expect(titled({ 'assets/js/CPM.js': dataFile(one, "cp.cv('cpInfoProjectName','Sample: Fire safety\\'s basics',1,15,0);") })).toBe("Sample: Fire safety's basics");
    expect(titled({ 'assets/js/CPM.js': dataFile(one), 'index.html': '<title>Fire safety (launch page)</title>' })).toBe('Fire safety (launch page)');
    expect(titled({ 'assets/js/CPM.js': dataFile(one) })).toBe('Fire_safety');
  });

  it('makes a course too long for one composition topics of fifty slides', () => {
    const slides = Array.from({ length: 100 }, (_, i) => slide(`Slide${i + 1}`, `Step ${i + 1}`, [[`Text_Caption_${i + 1}`, 19]], caption(`Text_Caption_${i + 1}`, 20, `Do step ${i + 1}.`)));
    const read = captivatePackage(filesOfZip(zipOf({ 'assets/js/CPM.js': dataFile(course(slides)) })), { fileUrl, title: 'Long course' })!;
    expect(read.topics.map(t => [t.title, t.pages.length])).toEqual([['Fire_safety: slides 1 to 50', 50], ['Fire_safety: slides 51 to 100', 50]]);
  });

  it('reads the literal as it is written, and runs nothing', () => {
    const src = "cp.D = cp.model.data = {a:{1366:{l:'0px'},b:[1,-2.5,.5],c:'it\\'s',sr:cp.fd,d:null,e:true},a:{x:1},/* a note */f:'',g:[,1]};";
    const start = src.indexOf('{');
    expect(literalAt(src, start)).toEqual({ value: { a: { x: 1 }, f: '', g: [null, 1] }, end: src.length - 1 });
    expect(literalAt("{a:{1366:{l:'0px'},b:[1,-2.5,.5],c:'it\\'s',sr:cp.fd,d:null,e:true}}", 0)!.value).toEqual({ a: { 1366: { l: '0px' }, b: [1, -2.5, 0.5], c: "it's", sr: { ref: 'cp.fd' }, d: null, e: true } });
    for (const code of ['{a:alert(1)}', '{a:function(){}}', '{a:new Image()}', "{a:'open", '{a:1', '{a:`x`}', '['.repeat(100_000)]) expect(literalAt(code, 0)).toBeNull();
  });

  it('reads nothing that is not a Captivate course', () => {
    const none = (files: Record<string, string>): ImportedPackage | null => captivatePackage(filesOfZip(zipOf(files)), { fileUrl });
    expect(none({ 'assets/js/project.js': 'var project = { slides: [] };' })).toBeNull();
    expect(none({ 'assets/js/CPM.js': 'cp.D = cp.model.data = {project_main:{slides:"Slide1"},Slide1:(function(){return {}})()};' })).toBeNull();
    expect(none({ 'assets/js/CPM.js': dataFile({ pref: { acc: 1 } }) })).toBeNull();
    expect(none({ 'index.html': '<p>Just a page.</p>' })).toBeNull();
  });
});
