/**
 * A COURSE STORYLINE PUBLISHED IS READ IN STORYLINE'S OWN MODEL.
 *
 * A package Storyline published is a player page its runtime draws each slide into, so read as web
 * pages it has nothing to fold. The course is JSON in html5/data/js/ (storyline-course.ts): data.js
 * (scenes, slides, question definitions, pictures), a file per slide (its layers, objects and
 * text), and frame.js (the menu, which alone titles a scene, and the notes), each a
 * `globalProvideData('<type>', '<JSON as a single-quoted string>')` call. The fixtures here are
 * made up, and shaped as real exports are.
 *
 * Here: each scene a topic of its content slides as pages, in the order a screen reader reads each
 * slide; what is not text left out with why; each kind of question right as Storyline grades it (a
 * form's choices as the form names them, a free-form question's as the slide shows them, a fill-in
 * with its letter case, a sort into groups, a drop-down match, an order, values compared); a bank
 * asked whole; the layouts Storyline publishes; and each read folded and graded.
 */
import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { filesOfZip, foldPackage, type ImportedPackage, type ImportedQuestion } from '../src/package-import.js';
import { provided, storylinePackage } from '../src/storyline-course.js';
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
/** A data file as Storyline writes one: its JSON a single-quoted JavaScript string, escapes and all. */
const provide = (type: string, json: object): string => {
  const quoted = JSON.stringify(json).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    .replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  return `window.globalProvideData('${type}', '${quoted}');`;
};

type Para = string | { text: string; tag?: string; list?: string };
/** A text box: its default state's text, a block per paragraph, as Storyline keeps it. */
const textBox = (id: string, tab: number, ...paras: Para[]): object => ({
  kind: 'vectorshape', id, accType: 'text', tabIndex: tab,
  textLib: [{ kind: 'textdata', linkId: `txt__default_${id}`, type: 'acctext', vartext: { blocks: paras.map(p => {
    const { text, tag = 'P', list } = typeof p === 'string' ? { text: p } : p;
    return { spans: [{ text, style: { fontSize: 20 } }], style: { tagType: tag, ...(list ? { listStyle: { listType: list } } : {}) } };
  }) } }],
});
const choiceBox = (id: string, tab: number, text: string, accType = 'radio'): object => ({ ...textBox(id, tab, text), accType });
const button = (id: string, tab: number, text: string): object => ({ ...textBox(id, tab, text), accType: 'button' });
const picture = (id: string, tab: number, assetId: number, altText: string): object => ({
  kind: 'vectorshape', id, accType: 'image', tabIndex: tab, imagelib: [{ kind: 'imagedata', assetId, url: `story_content/${id}.jpg`, altText }],
});
const slideFile = (id: string, layers: Array<{ objects: object[]; base?: boolean; audio?: boolean }>, extra: object = {}): string => provide('slide', {
  id, ...extra,
  slideLayers: layers.map((l, i) => ({ kind: 'slidelayer', ...(l.base ?? i === 0 ? { isBaseLayer: true } : { id: `layer${i}` }), objects: l.objects, ...(l.audio ? { audiolib: [{ kind: 'audio', assetId: 9 }] } : {}) })),
});
const correct = (evaluate: object): object[] => [{ kind: 'answer', status: 'correct', evaluate }, { kind: 'answer', status: 'incorrect', evaluate: { statements: [] } }];
const equals = (...ids: string[]): object => ({ statements: ids.map(id => ({ kind: 'equals', choiceid: `choices.choice_${id}`, ignorecase: false })) });
const pairs = (...ps: Array<[string, string]>): object => ({ statements: ps.map(([c, s]) => ({ kind: 'pair', choiceid: `choices.choice_${c}`, statementid: `statements.statement_${s}` })) });
const choices = (...cs: Array<[string, string]>): object[] => cs.map(([id, lmstext]) => ({ kind: 'choice', id: `choice_${id}`, lmstext }));
const statements = (...cs: Array<[string, string]>): object[] => cs.map(([id, lmstext]) => ({ kind: 'statement', id: `statement_${id}`, lmstext }));
const slide = (id: string, n: number, title: string, interactions?: object[]): object => ({
  kind: 'slide', id, title, html5url: `html5/data/js/${id}.js`, slideNumberInScene: n, ...(interactions ? { interactions } : {}),
});

// ── The sample course: "Ladder safety" ────────────────────────────────────────────────────────────

const SLIDES: Record<string, string> = {
  // Its objects out of reading order, a heading's shadow, a button, a variable, a literal percent
  // sign, narration.
  '5Welcome001': slideFile('5Welcome001', [{ audio: true, objects: [
    picture('iLadder0001', 3, 0, 'ladder.jpg'),
    textBox('tIntro00001', 2, 'Hi, %_player.Name%! Keep three points of contact, 100^%^ of the time.'),
    textBox('tHead000001', 1, { text: 'Ladder safety', tag: 'H1' }),
    textBox('tShadow0001', 1, { text: 'Ladder safety', tag: 'H1' }),
    button('bNext000001', 4, 'Next'),
    textBox('tScore00001', 5, '%_player.Score%'),
  ] }]),
  // Lists, a group with a text for each state, a layer that repeats an object, text as HTML, a
  // shape whose only text is another state's, text drawn as a shape (its alt text kept).
  '5Rungs00002': slideFile('5Rungs00002', [
    { objects: [
      textBox('tList000001', 1,
        { text: 'Face the ladder', list: 'bullet' }, { text: 'Keep your hips between the rails', list: 'bullet' },
        'Before each climb:', { text: 'Check the feet', list: 'listNumberedAsArabic' }, { text: 'Set the angle', list: 'listNumberedAsArabic' }),
      { kind: 'stategroup', id: 'sgTip000001', tabIndex: 9, objects: [
        { kind: 'vectorshape', id: 'sgTip000001', accType: 'text', tabIndex: 2 },
        textBox('tTip0000001', 3, 'Never stand on the top rung.'),
        textBox('tTip0000002', 4, 'Correct'),
        textBox('tTip0000003', 5, 'Never stand on the top rung.'),
      ] },
      { kind: 'vectorshape', id: 'tHtml000001', accType: 'text', tabIndex: 6, textLib: [{ kind: 'textdata', linkId: 'txt__default_tHtml000001', type: 'vectortext', vartext: '<p style="text-align:center"><span style="font-size:20px">Inspect &amp; tag it</span></p>' }] },
      { kind: 'vectorshape', id: 'tState00001', accType: 'text', tabIndex: 7, textLib: [{ kind: 'textdata', linkId: 'txt__default_Selected_tState00001', type: 'vectortext' }], data: { vectorData: { altText: 'Rectangle 1' } } },
      { kind: 'vectorshape', id: 'tDrawn00001', accType: 'text', tabIndex: 8, textLib: [{ kind: 'textdata', linkId: 'txt__default_tDrawn00001', type: 'vectortext' }], data: { vectorData: { altText: 'Wear boots with grip' } } },
    ] },
    { objects: [textBox('tList000001', 0, 'A copy the layer shares'), textBox('tMore000001', 1, 'Ask for help with a long ladder.')] },
  ]),
  // Shapes Storyline drew as pictures, and nothing else.
  '5Drawn00003': slideFile('5Drawn00003', [{ objects: [{ kind: 'vectorshape', id: 'shDrawn0001', accType: 'text', tabIndex: 1, imagelib: [{ kind: 'imagedata', assetId: 1, url: '' }] }] }]),
  '5Video00004': slideFile('5Video00004', [{ objects: [textBox('tWatch00001', 1, 'Watch the demonstration.'), { kind: 'video', id: 'vDemo000001', tabIndex: 2 }] }]),
  // A question built from a form, its choices shuffled; a counter, a heading, a review banner, a feedback layer.
  '5QMc0000005': slideFile('5QMc0000005', [
    { objects: [
      textBox('tCount00001', 0, '1/3'),
      textBox('tCheck00001', 1, 'Knowledge check'),
      textBox('tQ000000005', 2, 'How many points of contact should you keep?'),
      { kind: 'shufflegroup', shuffle: true, tabIndex: -1, objects: [choiceBox('cOne0000001', 3, 'One'), choiceBox('cTwo0000001', 4, 'Two'), choiceBox('cThree00001', 5, 'Three')] },
      button('bSubmit0001', 6, 'Submit'),
      textBox('5qMc_CorrectReview', 7, 'Correct'),
    ] },
    { objects: [textBox('tRight00001', 0, 'That is right!')] },
  ]),
  // A free-form question: each choice a group with a text for each state; the label only its type,
  // so the question is the slide's text, without its counter, its score or its review banner.
  '5QFree00006': slideFile('5QFree00006', [
    { objects: [
      textBox('tCount00006', 0, '2/3'),
      textBox('tQ000000006', 1, 'Which ladder suits work indoors?'),
      textBox('tPts0000006', 2, '%_player.Score% points'),
      { kind: 'stategroup', id: 'sgA00000001', tabIndex: 20, objects: [
        { kind: 'vectorshape', id: 'sgA00000001', accType: 'radio', tabIndex: 3 }, textBox('tA000000001', 4, 'A step ladder'), textBox('tA000000002', 5, 'Right'), textBox('tA000000003', 6, 'A step ladder'),
      ] },
      { kind: 'stategroup', id: 'sgB00000001', tabIndex: 21, objects: [
        { kind: 'vectorshape', id: 'sgB00000001', accType: 'radio', tabIndex: 7 }, textBox('tB000000001', 8, 'An extension ladder'), textBox('tB000000002', 9, 'Right'),
      ] },
      textBox('5qFree_CorrectReview', 22, 'Correct'),
    ] },
    { objects: [textBox('tWrong00006', 0, 'Not quite: an extension ladder is for work outdoors.')] },
  ]),
  // A passage the question asks about, longer than the question's own words.
  '5QMr0000007': slideFile('5QMr0000007', [{ objects: [
    textBox('tNote000007', 1, 'The inspection note says the left rail is cracked and a rung is missing; the feet were cleaned this morning.'),
    textBox('tQ000000007', 2, 'Which make this ladder unsafe?'),
    choiceBox('cRail000001', 3, 'The cracked rail', 'checkbox'), choiceBox('cFeet000001', 4, 'The clean feet', 'checkbox'), choiceBox('cRung000001', 5, 'The missing rung', 'checkbox'),
  ] }]),
  '5QText00008': slideFile('5QText00008', [{ objects: [textBox('tQ000000008', 1, 'What do you do before every climb?'), { kind: 'textinput', id: 'inText00001', tabIndex: 2, data: { textdata: { altText: 'type your answer here' } } }] }]),
  '5QCase00009': slideFile('5QCase00009', [{ objects: [textBox('tQ000000009', 1, 'Name the rung you never stand on: the ____ rung.')] }]),
  // Items sorted into groups: several go to one place.
  '5QSort00010': slideFile('5QSort00010', [{ objects: [
    textBox('tQ000000010', 1, 'Sort each item.'),
    textBox('dHat0000001', 2, 'Hard hat'), textBox('dBoot000001', 3, 'Boots'), textBox('dLadr000001', 4, 'Ladder'),
    textBox('pWear000001', 5, 'Wear it'), textBox('pClmb000001', 6, 'Climb it'),
  ] }]),
  // A drop-down match built from a form: its statements labelled on the slide, its choices only in the form.
  '5QDrop00011': slideFile('5QDrop00011', [{ objects: [
    textBox('tQ000000011', 1, 'Where is each ladder used?'), textBox('sStep000001', 2, 'Step ladder:'), textBox('sExt0000001', 3, 'Extension ladder:'),
  ] }]),
  '5QOrdr00012': slideFile('5QOrdr00012', [{ objects: [textBox('tQ000000012', 1, 'Put the steps in order.')] }]),
  '5QNum000013': slideFile('5QNum000013', [{ objects: [textBox('tQ000000013', 1, 'Roughly how many degrees is a safe ladder angle?')] }]),
  '5QRang00014': slideFile('5QRang00014', [{ objects: [textBox('tQ000000014', 1, 'Name a safe ladder angle.')] }]),
  '5QSurv00015': slideFile('5QSurv00015', [{ objects: [textBox('tQ000000015', 1, 'How confident are you?')] }]),
  '5QSpot00016': slideFile('5QSpot00016', [{ objects: [textBox('tQ000000016', 1, 'Click the unsafe rung.')] }]),
  '5QPict00017': slideFile('5QPict00017', [{ objects: [
    textBox('tQ000000017', 1, 'Which is a step ladder?'),
    { kind: 'vectorshape', id: 'pPicA000001', accType: 'radio', tabIndex: 2, imagelib: [{ kind: 'imagedata', assetId: 0, altText: 'a.jpg' }] },
    { kind: 'vectorshape', id: 'pPicB000001', accType: 'radio', tabIndex: 3, imagelib: [{ kind: 'imagedata', assetId: 0, altText: 'b.jpg' }] },
  ] }]),
  '5QOnly00018': slideFile('5QOnly00018', [{ objects: [picture('iOnly000001', 1, 0, 'question.jpg')] }]),
  '5QMix000020': slideFile('5QMix000020', [{ objects: [textBox('tQ000000020', 1, 'Name the part you hold.')] }]),
  // A match built from a form: its places drop areas, the items to drag beside them (longer than
  // the question, and not its text).
  '5QPair00021': slideFile('5QPair00021', [{ objects: [
    textBox('tQ000000021', 1, 'Match them.'),
    { kind: 'droparea', id: 'aRung000001', tabIndex: 2, data: { textdata: { altText: 'Rung' } } },
    { kind: 'droparea', id: 'aRail000001', tabIndex: 3, data: { textdata: { altText: 'Rail' } } },
    { kind: 'dragitem', id: 'gStep000001', tabIndex: 4, data: { textdata: { altText: 'A step you stand on' } } },
    { kind: 'dragitem', id: 'gSide000001', tabIndex: 5, data: { textdata: { altText: 'A side you hold' } } },
  ] }]),
  // Places that read the same: which is which is only where each is.
  '5QSame00022': slideFile('5QSame00022', [{ objects: [
    textBox('tQ000000022', 1, 'Drag each word to its definition.'),
    textBox('wFoot000001', 2, 'Foot'), textBox('wCap0000001', 3, 'Cap'), textBox('qOne0000001', 4, '?'), textBox('qTwo0000001', 5, '?'),
  ] }]),
  '5QDup000023': slideFile('5QDup000023', [{ objects: [
    textBox('tQ000000023', 1, 'Pick every reading of 10.'),
    choiceBox('kA00000001', 2, '10', 'checkbox'), choiceBox('kB00000001', 3, '10', 'checkbox'), choiceBox('kC00000001', 4, '8', 'checkbox'),
  ] }]),
  '6BankTF0001': slideFile('6BankTF0001', [{ objects: [textBox('tQ00000bk01', 1, 'A ladder may lean on a window.'), choiceBox('cTrue000001', 2, 'True'), choiceBox('cFals000001', 3, 'False')] }]),
  '6BankMC0001': slideFile('6BankMC0001', [{ objects: [textBox('tQ00000bk02', 1, 'Who may use a damaged ladder?')] }]),
  // The quiz's results slide: it evaluates the quiz, and shows its score.
  '5Result0019': slideFile('5Result0019', [{ objects: [textBox('tRes0000001', 1, 'You scored %_player.6Quiz000001.$ScorePercent%^%^'), textBox('tRes0000002', 2, 'Well done.')] }],
    { events: [{ kind: 'ontimelinestart', actions: [{ kind: 'exe_actiongroup', id: '_player.6Quiz000001.EvaluateQuiz' }] }] }),
};

const DATA = {
  scenes: [
    // The player's own prompts: never content.
    { kind: 'scene', id: '6Messages01', isMessageScene: true, sceneNumber: 0, slides: [{ kind: 'slide', id: 'InvalidPromptSlide', title: '<p>Invalid Answer</p>', slideLayers: [] }] },
    // Listed second, numbered second: read in the scenes' own order.
    { kind: 'scene', id: '6Check00002', isMessageScene: false, sceneNumber: 2,
      slides: [
        slide('5QFree00006', 1, 'Pick One', [{ kind: 'interaction', type: 'multiplechoice', lmsId: 'FreeFormPickOne', lmstext: 'Pick One',
          choices: choices(['sgA00000001', 'Rectangle 1'], ['sgB00000001', 'Rectangle 2']), answers: correct(equals('sgA00000001')) }]),
        slide('5QMr0000007', 2, 'Question 2', [{ kind: 'interaction', type: 'multipleresponse', lmsId: 'MultiResponse', lmstext: 'Which make this ladder unsafe?',
          choices: choices(['cRail000001', 'The cracked rail'], ['cFeet000001', 'The clean feet'], ['cRung000001', 'The missing rung']), answers: correct(equals('cRail000001', 'cRung000001')) }]),
        slide('5QText00008', 3, 'Text Entry', [{ kind: 'interaction', type: 'fillin', lmsId: 'FreeFormTextEntry', lmstext: 'Text Entry Interaction',
          choices: choices(['{7A1B}', 'inspect'], ['{7A1C}', 'check']),
          answers: correct({ statements: [{ kind: 'equals', choiceid: 'choices.choice_{7A1B}', ignorecase: true }, { kind: 'equals', choiceid: 'choices.choice_{7A1C}', ignorecase: true }] }) }]),
        slide('5QCase00009', 4, 'Fill in the Blank', [{ kind: 'interaction', type: 'fillin', lmsId: 'FillInTheBlank', lmstext: 'Name the rung you never stand on: the ____ rung.',
          choices: choices(['{7A1D}', 'Top']), answers: correct(equals('{7A1D}')) }]),
        slide('5QSort00010', 5, 'Drag and Drop', [{ kind: 'interaction', type: 'matching', lmsId: 'FreeFormDragDrop', lmstext: 'Drag and Drop',
          choices: choices(['dHat0000001', 'Rectangle 3'], ['dBoot000001', 'Rectangle 4'], ['dLadr000001', 'Rectangle 5']),
          statements: statements(['pWear000001', 'Rectangle 6'], ['pClmb000001', 'Rectangle 7']),
          answers: correct(pairs(['dHat0000001', 'pWear000001'], ['dBoot000001', 'pWear000001'], ['dLadr000001', 'pClmb000001'])) }]),
        slide('5QDrop00011', 6, 'Matching Drop-down', [{ kind: 'interaction', type: 'matching', lmsId: 'MatchingDropDown', lmstext: 'Where is each ladder used?',
          choices: choices(['mIn00000001', 'Indoors'], ['mRoof000001', 'Roof access'], ['mTree000001', 'Tree trimming']),
          statements: statements(['sStep000001', 'Step ladder'], ['sExt0000001', 'Extension ladder']),
          answers: correct(pairs(['mIn00000001', 'sStep000001'], ['mRoof000001', 'sExt0000001'])) }]),
        slide('5QOrdr00012', 7, 'Sequence', [{ kind: 'interaction', type: 'sequence', lmsId: 'SequenceDragDrop', lmstext: 'Put the steps in order.',
          choices: choices(['oSet0000001', 'Set the angle'], ['oFeet000001', 'Check the feet'], ['oClmb000001', 'Climb']),
          statements: statements(['oSet0000001', '2'], ['oFeet000001', '1'], ['oClmb000001', '3']),
          answers: correct(pairs(['oSet0000001', 'oSet0000001'], ['oFeet000001', 'oFeet000001'], ['oClmb000001', 'oClmb000001'])) }]),
        slide('5QNum000013', 8, 'Numeric', [{ kind: 'interaction', type: 'numeric', lmsId: 'Numeric', lmstext: 'Roughly how many degrees is a safe ladder angle?',
          answers: correct({ statements: [{ kind: 'condition', statement: { kind: 'or', statements: [
            { kind: 'compare', operator: 'eq', valuea: '5QNum000013.Value', valueb: 75 }, { kind: 'compare', operator: 'eq', valuea: '5QNum000013.Value', valueb: '76' }] } }] }) }]),
        slide('5QRang00014', 9, 'Numeric', [{ kind: 'interaction', type: 'numeric', lmsId: 'Numeric', lmstext: 'Name a safe ladder angle.',
          answers: correct({ statements: [{ kind: 'condition', statement: { kind: 'or', statements: [{ kind: 'and', statements: [
            { kind: 'compare', operator: 'gte', valuea: 'x.Value', valueb: 70 }, { kind: 'compare', operator: 'lte', valuea: 'x.Value', valueb: 80 }] }] } }] }) }]),
        slide('5QSurv00015', 10, 'Likert', [{ kind: 'interaction', type: 'likert', lmsId: 'LikertScale', lmstext: 'How confident are you?', issurvey: true, answers: [] }]),
        slide('5QSpot00016', 11, 'Hotspot', [{ kind: 'interaction', type: 'hotspot', lmsId: 'HotSpot', lmstext: 'Click the unsafe rung.', answers: correct(equals('spot')) }]),
        slide('5QPict00017', 12, 'Pick One', [{ kind: 'interaction', type: 'multiplechoice', lmsId: 'FreeFormPickOne', lmstext: 'Pick One',
          choices: choices(['pPicA000001', 'Picture 1'], ['pPicB000001', 'Picture 2']), answers: correct(equals('pPicA000001')) }]),
        slide('5QOnly00018', 13, 'Pick One', [{ kind: 'interaction', type: 'multiplechoice', lmsId: 'FreeFormPickOne', lmstext: 'Pick One',
          choices: choices(['x1', 'A'], ['x2', 'B']), answers: correct(equals('x1')) }]),
        slide('5QMix000020', 15, 'Text Entry', [{ kind: 'interaction', type: 'fillin', lmsId: 'FreeFormTextEntry', lmstext: 'Text Entry Interaction',
          choices: choices(['{7A1E}', 'Rail'], ['{7A1F}', 'side rail']),
          answers: correct({ statements: [{ kind: 'equals', choiceid: 'choices.choice_{7A1E}', ignorecase: false }, { kind: 'equals', choiceid: 'choices.choice_{7A1F}', ignorecase: true }] }) }]),
        slide('5QPair00021', 16, 'Matching Drag-and-drop', [{ kind: 'interaction', type: 'matching', lmsId: 'MatchingDragDrop', lmstext: 'Match them.',
          choices: choices(['cStep000021', 'A step you stand on'], ['cSide000021', 'A side you hold']),
          statements: statements(['aRung000001', 'Rung'], ['aRail000001', 'Rail']),
          answers: correct(pairs(['cStep000021', 'aRung000001'], ['cSide000021', 'aRail000001'])) }]),
        slide('5QSame00022', 17, 'Drag and Drop', [{ kind: 'interaction', type: 'matching', lmsId: 'FreeFormDragDrop', lmstext: 'Drag and Drop',
          choices: choices(['wFoot000001', 'Rectangle 8'], ['wCap0000001', 'Rectangle 9']),
          statements: statements(['qOne0000001', 'Rectangle 10'], ['qTwo0000001', 'Rectangle 11']),
          answers: correct(pairs(['wFoot000001', 'qOne0000001'], ['wCap0000001', 'qTwo0000001'])) }]),
        slide('5QDup000023', 18, 'Pick Many', [{ kind: 'interaction', type: 'multipleresponse', lmsId: 'FreeFormPickMany', lmstext: 'Pick Many',
          choices: choices(['kA00000001', 'Checkbox 1'], ['kB00000001', 'Checkbox 2'], ['kC00000001', 'Checkbox 3']), answers: correct(equals('kA00000001', 'kB00000001')) }]),
        slide('5Result0019', 19, 'Results Slide'),
      ],
      // A bank the scene draws from, between its thirteenth and fifteenth slides.
      slidedraws: [{ kind: 'slidedraw', id: '6Draw000001', lmsId: 'QuestionDraw01', slideNumberInScene: 14, shuffle: true, shufflecount: 1,
        sliderefs: [{ kind: 'slideref', id: '6BankTF0001' }, { kind: 'slideref', id: '6BankMC0001' }] }] },
    { kind: 'scene', id: '6Basics0001', isMessageScene: false, sceneNumber: 1,
      slides: [
        slide('5QMc0000005', 5, 'Question 1', [{ kind: 'interaction', type: 'multiplechoice', lmsId: 'MultiChoice', lmstext: 'How many points of contact should you keep?',
          choices: choices(['cOne0000001', 'One'], ['cTwo0000001', 'Two'], ['cThree00001', 'Three']), answers: correct(equals('cThree00001')) }]),
        slide('5Welcome001', 1, 'Welcome'),
        slide('5Rungs00002', 2, 'Untitled Slide'),
        slide('5Drawn00003', 3, 'Diagram'),
        slide('5Video00004', 4, 'Watch'),
      ] },
  ],
  slideBank: { slides: [
    { kind: 'slide', id: '6BankTF0001', title: 'True/False', html5url: 'html5/data/js/6BankTF0001.js', interactions: [{ kind: 'interaction', type: 'truefalse', lmsId: 'TrueFalse', lmstext: 'A ladder may lean on a window.',
      choices: choices(['cTrue000001', 'True'], ['cFals000001', 'False']), answers: correct(equals('cFals000001')) }] },
    { kind: 'slide', id: '6BankMC0001', title: 'Question', html5url: 'html5/data/js/6BankMC0001.js', interactions: [{ kind: 'interaction', type: 'multiplechoice', lmsId: 'MultiChoice', lmstext: 'Who may use a damaged ladder?',
      choices: choices(['nNo00000001', 'No one'], ['nBoss000001', 'A supervisor']), answers: correct(equals('nNo00000001')) }] },
  ] },
  assetLib: [
    { kind: 'asset', id: 0, url: 'mobile/6Ladder01.jpg', mobileUrl: 'story_content/6Ladder01.swf' },
    { kind: 'asset', id: 1, url: 'mobile/txt__default_shDrawn0001.png' },
  ],
};

const FRAME = {
  controlOptions: { sidebarOptions: { titleText: 'Ladder safety (menu)' } },
  navData: { outline: { links: [
    { kind: 'slidelink', slideid: '_player.6Basics0001', displaytext: 'Ladder basics', links: [{ kind: 'slidelink', slideid: '_player.6Basics0001.5Welcome001', displaytext: 'Welcome' }] },
    { kind: 'slidelink', slideid: '_player.6Check00002', displaytext: 'Check &amp; practice', links: [] },
  ] } },
  notesData: [{ slideId: '6Basics0001.5Welcome001', slideBank: false, content: '<p style="text-align:left"><span style="font-size:12px">Welcome the learner by name.</span></p>' }],
};

const COURSE_FILES = (root = ''): Record<string, string | Buffer> => ({
  [`${root}meta.xml`]: '<?xml version="1.0" encoding="utf-8"?><meta><project id="6Proj000001" title="Sample: Ladder safety" version="1.0.0.0"><description /></project></meta>',
  [`${root}story.html`]: '<!DOCTYPE html><html><head><title>Ladder safety (launch page)</title></head><body><div id="app"></div></body></html>',
  [`${root}html5/data/js/data.js`]: provide('data', DATA),
  [`${root}html5/data/js/frame.js`]: provide('frame', FRAME),
  [`${root}mobile/6Ladder01.jpg`]: 'jpeg bytes',
  [`${root}mobile/txt__default_shDrawn0001.png`]: 'png bytes',
  ...Object.fromEntries(Object.entries(SLIDES).map(([id, body]) => [`${root}html5/data/js/${id}.js`, body])),
});
const MANIFEST = '<?xml version="1.0"?><manifest identifier="storyline" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"><organizations default="o"><organization identifier="o"><title>Sample: Ladder safety</title><item identifier="i" identifierref="r"><title>Sample</title></item></organization></organizations>'
  + '<resources><resource identifier="r" type="webcontent" adlcp:scormtype="sco" href="index_lms.html"><file href="index_lms.html"/></resource></resources></manifest>';
/** A SCORM 1.2 package, as Storyline publishes one: the course at its root. */
const scormPackage = (): AdmZip => zipOf({ 'imsmanifest.xml': MANIFEST, 'index_lms.html': '<html><body><script src="lms/scormdriver.js"></script></body></html>', ...COURSE_FILES() });

/** Each question of a folded topic's check, as the engine stores it. */
const checkOf = (pkg: ImportedPackage, topic: number): ScormAssessmentQuestion[] => {
  const folded = foldPackage(pkg, { competency: 'ladders', blindFor: () => '0'.repeat(64) });
  const check = folded.items.find(i => i['@id'] === folded.topics[topic]!.check) as Fragment;
  return (check.questions ?? []) as ScormAssessmentQuestion[];
};
const letterOf = (q: Extract<ImportedQuestion, { type: 'choice' }>, option: string): string => String.fromCharCode(65 + q.options.indexOf(option));

describe('a course Storyline published for SCORM', () => {
  const read = storylinePackage(filesOfZip(scormPackage()), { fileUrl })!;

  it('is read in its own model: each scene a topic, titled as the player\'s menu titles it, in the scenes\' order', () => {
    expect(read.title).toBe('Sample: Ladder safety');
    expect(read.topics.map(t => [t.id, t.title, t.pages.length, t.questions.length])).toEqual([
      ['6Basics0001', 'Ladder basics', 3, 1],
      ['6Check00002', 'Check & practice', 0, 11],
    ]);
  });

  it('makes each content slide a page, read in the order a screen reader reads it, its pictures the package\'s own', () => {
    expect(read.topics[0]!.pages).toEqual([
      {
        path: 'html5/data/js/5Welcome001.js', title: 'Welcome',
        body: '# Ladder safety\n\nHi, …! Keep three points of contact, 100% of the time.\n\n![](https://bridge.example/files/mobile/6Ladder01.jpg)\n\n# Notes\n\nWelcome the learner by name.',
      },
      {
        path: 'html5/data/js/5Rungs00002.js', title: 'Slide 2',
        body: '- Face the ladder\n- Keep your hips between the rails\n\nBefore each climb:\n\n1. Check the feet\n2. Set the angle\n\nNever stand on the top rung.\n\nInspect & tag it\n\nWear boots with grip\n\nAsk for help with a long ladder.',
      },
      { path: 'html5/data/js/5Video00004.js', title: 'Watch', body: 'Watch the demonstration.' },
    ]);
  });

  it('reads a question built from a form as its form names it, and turns the choices the slide shuffles', () => {
    const [q] = read.topics[0]!.questions as Array<Extract<ImportedQuestion, { type: 'choice' }>>;
    // Its own words, not the heading beside them or the counter; the review banner is the learner's.
    expect(q!.question).toBe('How many points of contact should you keep?');
    expect([...q!.options].sort()).toEqual(['One', 'Three', 'Two']);
    expect(q!.options).not.toEqual(['One', 'Two', 'Three']);
    expect(q!.answer).toBe(letterOf(q!, 'Three'));
  });

  it('reads each question as Storyline grades it, and a bank the scene draws from whole', () => {
    expect(read.topics[1]!.questions).toEqual([
      // Free-form: the choices are the slide's objects, each the text of its first state.
      { question: 'Which ladder suits work indoors?', type: 'choice', options: ['A step ladder', 'An extension ladder'], answer: 'A' },
      // The passage it asks about is kept beside its own words.
      { question: 'The inspection note says the left rail is cracked and a rung is missing; the feet were cleaned this morning.\n\nWhich make this ladder unsafe?',
        type: 'choice', options: ['The cracked rail', 'The clean feet', 'The missing rung'], answer: ['A', 'C'], multiple: true },
      { question: 'What do you do before every climb?', type: 'fill-in', answer: 'inspect', accept: ['check'], compare: 'exact' },
      { question: 'Name the rung you never stand on: the ____ rung.', type: 'fill-in', answer: 'Top', caseSensitive: true, compare: 'exact' },
      // Sorted into groups: each item, and the place it goes.
      { question: 'Sort each item.', type: 'matching', pairs: [['Hard hat', 'Wear it'], ['Boots', 'Wear it'], ['Ladder', 'Climb it']] },
      // A drop-down asks of each statement which choice; a choice no statement takes is a distractor.
      { question: 'Where is each ladder used?', type: 'matching', pairs: [['Step ladder', 'Indoors'], ['Extension ladder', 'Roof access']], distractors: ['Tree trimming'] },
      { question: 'Put the steps in order.', type: 'sequencing', items: ['Check the feet', 'Set the angle', 'Climb'] },
      { question: 'Roughly how many degrees is a safe ladder angle?', type: 'numeric', answer: 75, accept: [76] },
      { question: 'A ladder may lean on a window.', type: 'choice', options: ['True', 'False'], answer: 'B' },
      { question: 'Who may use a damaged ladder?', type: 'choice', options: ['No one', 'A supervisor'], answer: 'A' },
      // A form's match: the items it names, beside the drop areas it names.
      { question: 'Match them.', type: 'matching', pairs: [['A step you stand on', 'Rung'], ['A side you hold', 'Rail']] },
    ]);
  });

  it('leaves out what is not text or a question it could ask, and says why', () => {
    const q = (id: string): string => `html5/data/js/data.js#6Check00002/${id}`;
    expect(read.unread).toEqual([
      { path: 'html5/data/js/data.js#6Basics0001/5Drawn00003', why: 'what it shows is drawn as shapes, which are not read' },
      { path: 'html5/data/js/data.js#6Basics0001/5Video00004', why: 'a video, which is not text' },
      { path: q('5QRang00014'), why: 'its right answer is a range or a comparison, not a value' },
      { path: q('5QSurv00015'), why: 'a survey question, which grades nothing' },
      { path: q('5QSpot00016'), why: 'a hotspot question, which a check here would not show' },
      { path: q('5QPict00017'), why: 'a choice is a picture, which a check here would not show' },
      { path: q('5QOnly00018'), why: 'its question is a picture or a video, which a check here would not show' },
      { path: q('5QMix000020'), why: 'its answers differ in whether letter case counts, and a question here grades them one way' },
      { path: q('5QSame00022'), why: 'its places read the same, so which is which is only where each is on the slide' },
      { path: q('5QDup000023'), why: 'two of its choices read the same, so which is which is only where each is on the slide' },
      { path: q('5Result0019'), why: "a quiz's results slide: the score it shows is a running course's" },
      { path: 'html5/data/js/data.js', why: 'narration on one slide, which is not text' },
    ]);
  });

  it('folds into checks graded as Storyline grades them', () => {
    const [contact] = checkOf(read, 0);
    const mc = read.topics[0]!.questions[0] as Extract<ImportedQuestion, { type: 'choice' }>;
    expect(questionIsRight(letterOf(mc, 'Three'), contact!)).toBe(true);
    expect(questionIsRight(letterOf(mc, 'Two'), contact!)).toBe(false);
    const [indoors, unsafe, before, top, sort, where, order, angle, window, damaged, parts] = checkOf(read, 1);
    expect(questionIsRight('A', indoors!)).toBe(true);
    expect(questionIsRight('A, C', unsafe!)).toBe(true);
    expect(questionIsRight('A, B', unsafe!)).toBe(false);
    expect(questionIsRight('CHECK', before!)).toBe(true);
    expect(questionIsRight('Top', top!)).toBe(true);
    expect(questionIsRight('top', top!)).toBe(false);
    const placed = (q: ScormAssessmentQuestion, answers: string[]): string => {
      const targets = (q as ScormAssessmentQuestion & { input: { targets: string[] } }).input.targets;
      return answers.map(t => String.fromCharCode(65 + targets.indexOf(t))).join(', ');
    };
    expect(questionIsRight(placed(sort!, ['Wear it', 'Wear it', 'Climb it']), sort!)).toBe(true);
    expect(questionIsRight(placed(sort!, ['Wear it', 'Climb it', 'Climb it']), sort!)).toBe(false);
    expect(questionIsRight(placed(where!, ['Indoors', 'Roof access']), where!)).toBe(true);
    const inOrder = (q: ScormAssessmentQuestion, items: string[]): string => {
      const shown = (q as ScormAssessmentQuestion & { input: { items: string[] } }).input.items;
      return items.map(t => String.fromCharCode(65 + shown.indexOf(t))).join(', ');
    };
    expect(questionIsRight(inOrder(order!, ['Check the feet', 'Set the angle', 'Climb']), order!)).toBe(true);
    expect(questionIsRight(inOrder(order!, ['Set the angle', 'Check the feet', 'Climb']), order!)).toBe(false);
    expect(questionIsRight('75', angle!)).toBe(true);
    expect(questionIsRight('76', angle!)).toBe(true);
    expect(questionIsRight('80', angle!)).toBe(false);
    expect(questionIsRight('B', window!)).toBe(true);
    expect(questionIsRight('A', damaged!)).toBe(true);
    expect(questionIsRight(placed(parts!, ['Rung', 'Rail']), parts!)).toBe(true);
    expect(questionIsRight(placed(parts!, ['Rail', 'Rung']), parts!)).toBe(false);
  });

  it('is what the fold reads a hosted package as, before its pages; a SCORM package is played as one', () => {
    expect(readAnyPackage(filesOfZip(scormPackage()), { fileUrl })).toEqual(read);
    expect(projectExportOf(scormPackage().toBuffer())).toBeNull();
  });
});

describe('the other ways Storyline publishes a course', () => {
  it('reads one published for xAPI or the web, in a folder of its own, and keeps it to be folded', () => {
    const web = zipOf(COURSE_FILES('Ladder safety - Storyline output/'));
    const read = storylinePackage(filesOfZip(web), { fileUrl })!;
    expect(read.topics[0]!.pages[0]!.path).toBe('Ladder safety - Storyline output/html5/data/js/5Welcome001.js');
    expect(read.topics[0]!.pages[0]!.body).toContain('(https://bridge.example/files/Ladder%20safety%20-%20Storyline%20output/mobile/6Ladder01.jpg)');
    expect(projectExportOf(web.toBuffer())).toMatchObject({ tool: 'Storyline', title: 'Sample: Ladder safety' });
    const xapi = zipOf({ 'tincan.xml': '<tincan/>', ...COURSE_FILES() });
    expect(projectExportOf(xapi.toBuffer())).toMatchObject({ tool: 'Storyline' });
  });

  it('titles the course by its launch page, else its player, when it has no meta.xml', () => {
    const { 'meta.xml': _meta, ...rest } = COURSE_FILES();
    expect(storylinePackage(filesOfZip(zipOf(rest)), { fileUrl })!.title).toBe('Ladder safety (launch page)');
    const { 'story.html': _story, ...bare } = rest;
    expect(storylinePackage(filesOfZip(zipOf(bare)), { fileUrl })!.title).toBe('Ladder safety (menu)');
  });

  it('makes a scene too long for one composition topics of fifty slides, titled by the course when it is its only scene', () => {
    const slides = Array.from({ length: 100 }, (_, i) => slide(`5Long${String(i).padStart(6, '0')}`, i + 1, `Step ${i + 1}`));
    const files: Record<string, string> = {
      'html5/data/js/data.js': provide('data', { scenes: [
        { kind: 'scene', id: '6Messages01', isMessageScene: true, sceneNumber: 0, slides: [] },
        { kind: 'scene', id: '6Long000001', sceneNumber: 1, slides },
      ], assetLib: [] }),
      // The menu's default name for a scene is no title.
      'html5/data/js/frame.js': provide('frame', { navData: { outline: { links: [{ kind: 'slidelink', slideid: '_player.6Long000001', displaytext: 'Untitled Scene' }] } } }),
      ...Object.fromEntries(slides.map((s, i) => [`html5/data/js/${(s as { id: string }).id}.js`, slideFile((s as { id: string }).id, [{ objects: [textBox('t', 1, `Do step ${i + 1}.`)] }])])),
    };
    const read = storylinePackage(filesOfZip(zipOf(files)), { fileUrl, title: 'Long course' })!;
    expect(read.topics.map(t => [t.title, t.pages.length])).toEqual([['Long course: slides 1 to 50', 50], ['Long course: slides 51 to 100', 50]]);
  });

  it('decodes a data file without running it, and reads nothing that is not one', () => {
    // A quote, a \u escape and a \x escape as JavaScript reads them; \\n a backslash and n, so JSON's own escape.
    expect(provided("window.globalProvideData('slide', '{\"a\":\"it\\'s \\u00e9\\x41\\\\n\"}');", 'slide')).toEqual({ a: "it's éA\n" });
    expect(provided("window.globalProvideData('frame', '{}');", 'slide')).toBeNull();
    expect(storylinePackage(filesOfZip(zipOf({ 'html5/data/js/data.js': 'var data = {};' })), { fileUrl })).toBeNull();
    expect(storylinePackage(filesOfZip(zipOf({ 'index.html': '<p>Just a page.</p>' })), { fileUrl })).toBeNull();
  });

  it('reads a data file of a great many escapes in one pass over it', () => {
    // Every double quote in a course's text is an escape in its data file, and a long course can
    // hold hundreds of thousands: each is decoded where it is, not by searching the rest of the file.
    const text = '"'.repeat(300_000);
    const file = provide('slide', { id: 's', text });
    const t0 = Date.now();
    expect(provided(file, 'slide')).toEqual({ id: 's', text });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('leaves a Rise course that holds a Storyline block to be read as Rise', () => {
    const rise = { course: { title: 'Rise outside', lessons: [{ id: 'l', type: 'blocks', title: 'Lesson', items: [{ id: 'b', type: 'text', family: 'text', variant: 'paragraph', items: [{ paragraph: '<p>Words.</p>' }] }] }] }, labelSet: {}, fonts: [], media: {} };
    const zip = zipOf({ 'index.html': `<script>window.courseData = "${Buffer.from(JSON.stringify(rise)).toString('base64')}";</script>`, ...COURSE_FILES('assets/block1/') });
    expect(readAnyPackage(filesOfZip(zip), { fileUrl })).toEqual(risePackage(filesOfZip(zip), { fileUrl }));
    expect(readAnyPackage(filesOfZip(zip), { fileUrl }).title).toBe('Rise outside');
  });
});

// ── What a review of #579 found ────────────────────────────────────────────────────────────────────

/** An object whose click runs these actions: Storyline marks it a button. */
const clicking = (o: object, ...actions: object[]): object => ({ ...o, events: [{ kind: 'onrelease', actions }] });
const GO = { kind: 'gotoplay', window: '_current', wndtype: 'normal', objRef: { type: 'string', value: '_player.6Scene00001.6Next000001' } };
const SHOW_LAYER = { kind: 'show_slidelayer', hideOthers: 'oncomplete', transition: 'appear', objRef: { type: 'string', value: '_parent.6Layer00001' } };
const CLOSE_LAYER = { kind: 'hide_slidelayer', transition: 'appear', objRef: { type: 'string', value: '_parent' } };
const SUBMIT = { kind: 'exe_actiongroup', id: 'ActGrpOnSubmitButtonClick' };
const SELECT = { kind: 'adjustvar', variable: '_checked', operator: 'toggle' };
/** A course of one scene: its slides, their files, and what else its data holds. */
const oneScene = (slides: Array<[object, string]>, data: object = {}, scene: object = {}): Record<string, string> => ({
  'html5/data/js/data.js': provide('data', { scenes: [{ kind: 'scene', id: '6Scene00001', sceneNumber: 1, slides: slides.map(([entry]) => entry), ...scene }], assetLib: [], ...data }),
  ...Object.fromEntries(slides.map(([entry, file]) => [`html5/data/js/${(entry as { id: string }).id}.js`, file])),
});
const readOf = (files: Record<string, string>, title = 'Sample'): ImportedPackage => storylinePackage(filesOfZip(zipOf(files)), { fileUrl, title })!;

describe('what a review of #579 found', () => {
  it('keeps a slide\'s notes that show a picture (Codex, on #583)', () => {
    const page = slideFile('6Note000001', [{ objects: [textBox('tNote000001', 1, 'Know the map.')] }]);
    const files = {
      ...oneScene([[slide('6Note000001', 1, 'Map'), page]]),
      'html5/data/js/frame.js': provide('frame', { notesData: [{ slideId: '6Scene00001.6Note000001', content: '<p>Point to the exits.</p><p><img src="story_content/map.png" alt="Floor map"></p>' }] }),
      'story_content/map.png': 'png',
    };
    expect(readOf(files).topics[0]!.pages[0]!.body).toBe('Know the map.\n\n# Notes\n\nPoint to the exits.\n\n![Floor map](https://bridge.example/files/story_content/map.png)');
  });

  it('reads a button as the slide shows it (a tab, a reference), unless it takes the learner on', () => {
    const page = slideFile('6Tabs000001', [
      { objects: [
        textBox('tHead000001', 1, 'Four ways to find ideas'),
        // A tab: its click shows a layer. A reference Storyline marks a button, its trigger kept elsewhere.
        clicking(button('bTab0000001', 2, 'Brainstorming'), SHOW_LAYER),
        button('bRef0000001', 3, 'Hall, D. T. (1999). Behind closed doors.'),
        // The player's way on: another slide; a layer closed; a short label with its trigger elsewhere.
        clicking(button('bOn00000001', 4, 'Continue to the next part'), { kind: 'if_action', condition: { statement: { kind: 'compare', operator: 'eq', valuea: '_player.#visited', valueb: true } }, thenActions: [GO] }),
        clicking(button('bClose00001', 5, 'Close'), CLOSE_LAYER),
        button('bMenu000001', 6, 'Menu'),
        // Three words are no short label.
        button('bRead000001', 7, 'Read the policy'),
      ] },
      { base: false, objects: [
        textBox('tMore000001', 1, 'Say every idea out loud.'),
        clicking(button('bBack000001', 2, 'Back to the four ways'), CLOSE_LAYER),
        // It shows the next layer as it closes its own: what it names is more of the slide.
        clicking(button('bNextM00001', 3, 'Next: mind maps'), CLOSE_LAYER, SHOW_LAYER),
      ] },
    ]);
    expect(readOf(oneScene([[slide('6Tabs000001', 1, 'Ideas'), page]])).topics[0]!.pages[0]!.body)
      .toBe('Four ways to find ideas\n\nBrainstorming\n\nHall, D. T. (1999). Behind closed doors.\n\nRead the policy\n\nSay every idea out loud.\n\nNext: mind maps');
  });

  it('reads a question whose text and choices are buttons, and no counter or button label as its text', () => {
    const q = slideFile('6Q000000001', [{ objects: [
      textBox('tCount00001', 1, 'Question 1 of 3'),
      // Its own text, on an object Storyline marks a button (it shows a layer when clicked).
      clicking(button('bText000001', 2, 'Which of these makes a slide easier to read for everyone?'), SHOW_LAYER),
      clicking(button('cBig0000001', 3, 'Large, high-contrast text'), SELECT),
      clicking(button('cTiny000001', 4, 'Tiny grey text'), SELECT),
      clicking(button('bHint000001', 5, 'Show hint'), SHOW_LAYER),
      clicking(button('bSubmit0001', 6, 'Submit my answer'), SUBMIT),
    ] }]);
    const entry = slide('6Q000000001', 1, 'Question 1', [{ kind: 'interaction', type: 'multiplechoice', lmsId: 'FreeFormPickOne', lmstext: 'Pick One',
      choices: choices(['cBig0000001', 'Checkbox 1'], ['cTiny000001', 'Checkbox 2']), answers: correct(equals('cBig0000001')) }]);
    expect(readOf(oneScene([[entry, q]])).topics[0]!.questions).toEqual([
      { question: 'Which of these makes a slide easier to read for everyone?', type: 'choice', options: ['Large, high-contrast text', 'Tiny grey text'], answer: 'A' },
    ]);
  });

  it('leaves out a question that is a picture, its counter in words no text of its own', () => {
    const counted = (id: string, counter: string): [object, string] => [
      slide(id, 1, 'Question', [{ kind: 'interaction', type: 'multiplechoice', lmsId: 'MultiChoice', lmstext: 'Multiple Choice',
        choices: choices([`a${id}`, '5'], [`b${id}`, '4']), answers: correct(equals(`a${id}`)) }]),
      slideFile(id, [{ objects: [textBox(`t${id}`, 1, counter), picture(`i${id}`, 2, 0, 'Question'), textBox(`a${id}`, 3, '5'), textBox(`b${id}`, 4, '4')] }]),
    ];
    const read = readOf(oneScene([counted('6Q000000002', '1/10 soal'), counted('6Q000000003', 'Question 2 of 10')]));
    expect(read.topics).toEqual([]);
    expect(read.unread.map(u => u.why)).toEqual(Array(2).fill('its question is a picture or a video, which a check here would not show'));
  });

  it('asks a question two draws in a scene take from once', () => {
    const bank = { slides: DATA.slideBank.slides };
    const draws = [
      { kind: 'slidedraw', id: '6Draw000001', slideNumberInScene: 1, sliderefs: [{ kind: 'slideref', id: '6BankTF0001' }] },
      { kind: 'slidedraw', id: '6Draw000002', slideNumberInScene: 2, sliderefs: [{ kind: 'slideref', id: '6BankTF0001' }, { kind: 'slideref', id: '6BankMC0001' }] },
    ];
    const files = { ...oneScene([], { slideBank: bank }, { slidedraws: draws }), 'html5/data/js/6BankTF0001.js': SLIDES['6BankTF0001']!, 'html5/data/js/6BankMC0001.js': SLIDES['6BankMC0001']! };
    expect(readOf(files).topics[0]!.questions.map(q => q.question)).toEqual(['A ladder may lean on a window.', 'Who may use a damaged ladder?']);
  });

  it('reads a group that changes with its state as its own state, the object that shares its id', () => {
    const page = slideFile('6State00001', [{ objects: [
      { kind: 'stategroup', id: 'sgObst00001', tabIndex: 1, objects: [
        textBox('sgObst00002', 1, 'Obstacle: anything that blocks the way forward.'),
        textBox('sgObst00001', 1, 'Obstacle'),
      ] },
    ] }]);
    expect(readOf(oneScene([[slide('6State00001', 1, 'Terms'), page]])).topics[0]!.pages[0]!.body).toBe('Obstacle');
  });

  it('reads the title from a meta.xml of many open tags in one pass', () => {
    const page = slideFile('6Only000001', [{ objects: [textBox('tOnly000001', 1, 'Words.')] }]);
    const files = { ...oneScene([[slide('6Only000001', 1, 'Only'), page]]), 'meta.xml': '<project '.repeat(20_000), 'story.html': '<title>Sample: Tags</title>' };
    const t0 = Date.now();
    expect(readOf(files).title).toBe('Sample: Tags');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('a package that holds more than one course (a review of #579)', () => {
  const course = (title: string, text: string, scene?: string): Record<string, string> => ({
    'meta.xml': `<meta><project title="${title}"></project></meta>`,
    ...(scene ? { 'html5/data/js/frame.js': provide('frame', { navData: { outline: { links: [{ kind: 'slidelink', slideid: '_player.6Scene00001', displaytext: scene }] } } }) } : {}),
    ...oneScene([[slide('6Only000001', 1, 'Only'), slideFile('6Only000001', [{ objects: [textBox('tOnly000001', 1, text)] }])]]),
  });
  const inFolder = (root: string, files: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(files).map(([k, v]) => [`${root}${k}`, v]));

  it('reads each course in a zip of several, titled as its own', () => {
    const zip = zipOf({ ...inFolder('module-1/', course('Module 1: Ladders', 'Keep three points of contact.', 'Before you climb')), ...inFolder('module-2/', course('Module 2: Scaffolds', 'Check the guard rails.')) });
    const read = readAnyPackage(filesOfZip(zip), { fileUrl, title: 'Two modules' });
    expect(read.title).toBe('Two modules');
    expect(read.topics.map(t => [t.id, t.title, t.pages.map(pg => pg.body)])).toEqual([
      // A topic its course's own title does not name is titled by its course too.
      ['module-1/6Scene00001', 'Module 1: Ladders: Before you climb', ['Keep three points of contact.']],
      ['module-2/6Scene00001', 'Module 2: Scaffolds', ['Check the guard rails.']],
    ]);
    expect(projectExportOf(zip.toBuffer(), 'Two modules')).toMatchObject({ tool: 'Storyline', title: 'Two modules', read });
  });

  it('reads a SCORM package wrapped in a folder as the course it is', () => {
    const wrapped = zipOf(inFolder('Ladder safety/', { 'imsmanifest.xml': MANIFEST, 'index_lms.html': '<html><body></body></html>', ...(COURSE_FILES() as Record<string, string>) }));
    expect(readAnyPackage(filesOfZip(wrapped), { fileUrl })).toEqual(storylinePackage(filesOfZip(wrapped), { fileUrl }));
  });

  it('reads a SCORM package\'s other activities beside its Storyline course, the course after them', () => {
    const sco = (id: string, href: string): string => `<resource identifier="${id}" type="webcontent" adlcp:scormtype="sco" href="${href}"><file href="${href}"/></resource>`;
    const manifest = '<?xml version="1.0"?><manifest identifier="mixed" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"><organizations default="o"><organization identifier="o"><title>Forklift safety</title>'
      + '<item identifier="i1" identifierref="r1"><title>Lesson 1</title></item><item identifier="i2" identifierref="r2"><title>Lesson 2</title></item><item identifier="i3" identifierref="r3"><title>Practice</title></item>'
      + `</organization></organizations><resources>${sco('r1', 'lesson1.html')}${sco('r2', 'lesson2.html')}${sco('r3', 'practice/story.html')}</resources></manifest>`;
    const zip = zipOf({
      'imsmanifest.xml': manifest,
      'lesson1.html': '<html><head><title>Lesson 1</title></head><body><p>Check the forks.</p></body></html>',
      'lesson2.html': '<html><head><title>Lesson 2</title></head><body><p>Mind the load.</p></body></html>',
      ...inFolder('practice/', { ...course('Practice run', 'Drive slowly.'), 'story.html': '<html><body><div id="app"></div></body></html>' }),
    });
    // The manifest's title, not the upload's name.
    const read = readAnyPackage(filesOfZip(zip), { fileUrl, title: 'forklift.zip' });
    expect(read.title).toBe('Forklift safety');
    expect(read.topics.map(t => [t.title, t.pages.map(pg => pg.body)])).toEqual([['Lesson 1', ['Check the forks.']], ['Lesson 2', ['Mind the load.']], ['Practice run', ['Drive slowly.']]]);
  });
});
