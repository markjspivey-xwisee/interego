/**
 * A PACKAGE'S QUESTION BANK IS READ IN THE FORM IT DECLARES, WHATEVER THAT FORM IS.
 *
 * The fold read a package's questions only as calls to a Question constructor the package declares
 * (package-import.ts). Packages keep their banks in other forms too: the standard's own, IMS QTI
 * items (2.x, 3.0 and 1.2), and plain data, a JSON file or an array of question objects written out
 * in a script. question-banks.ts reads each by what its form declares, as choice, true-false,
 * numeric, fill-in, sequencing or matching, and what its form does not say is listed, not guessed.
 *
 * Here: each QTI interaction it reads and each it leaves out, QTI 3's spelling, QTI 1.2's scoring
 * conditions, data banks (options as text or flagged objects, letters, nested lists, what is not a
 * bank), a script's banks, and a package keeping all of them, read, folded and graded.
 */
import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { filesOfZip, foldPackage, literalBanks, readPackage } from '../src/package-import.js';
import { dataQuestions, qtiQuestions } from '../src/question-banks.js';
import { questionIsRight } from '../src/course-questions.js';
import type { ScormAssessmentQuestion } from '../src/scorm-assessment.js';
import type { Fragment } from '../src/content-fragments.js';

const QTI2 = 'xmlns="http://www.imsglobal.org/xsd/imsqti_v2p1"';
const item = (body: string, declaration: string, id = 'q1'): string =>
  `<?xml version="1.0" encoding="UTF-8"?><assessmentItem ${QTI2} identifier="${id}" title="T" adaptive="false" timeDependent="false">${declaration}<itemBody>${body}</itemBody></assessmentItem>`;
const declared = (cardinality: string, baseType: string, values: string[], more = ''): string =>
  `<responseDeclaration identifier="RESPONSE" cardinality="${cardinality}" baseType="${baseType}"><correctResponse>${values.map(v => '<value>' + v + '</value>').join('')}</correctResponse>${more}</responseDeclaration>`;
const one = (xml: string): unknown => {
  const read = qtiQuestions(xml, 'items/q.xml');
  expect(read).not.toBeNull();
  return read!.questions.length ? read!.questions[0] : read!.unread[0]!.why;
};

describe('a QTI 2 item', () => {
  it('reads a choice: its stem and prompt, its options in order, the one its correct response names', () => {
    const xml = item('<p>Which city is the <b>capital</b> of France?</p><choiceInteraction responseIdentifier="RESPONSE" maxChoices="1" shuffle="true"><prompt>Pick one.</prompt>'
      + '<simpleChoice identifier="A">Lyon</simpleChoice><simpleChoice identifier="B">Paris<feedbackInline outcomeIdentifier="F" identifier="B">Yes</feedbackInline></simpleChoice></choiceInteraction>',
    declared('single', 'identifier', ['B']));
    expect(one(xml)).toEqual({ question: 'Which city is the capital of France?\n\nPick one.', type: 'choice', options: ['Lyon', 'Paris'], answer: 'B' });
  });

  it('reads several right options as a list, and keeps it a multiple-response question', () => {
    const xml = item('<choiceInteraction responseIdentifier="RESPONSE" maxChoices="0"><prompt>Which are prime?</prompt><simpleChoice identifier="a">2</simpleChoice><simpleChoice identifier="b">4</simpleChoice><simpleChoice identifier="c">5</simpleChoice></choiceInteraction>',
      declared('multiple', 'identifier', ['a', 'c']));
    expect(one(xml)).toEqual({ question: 'Which are prime?', type: 'choice', options: ['2', '4', '5'], answer: ['A', 'C'], multiple: true });
  });

  it('reads a text entry as fill-in, with a blank where it sits and what its mapping also scores', () => {
    const entry = (caseSensitive: string): string => item('<p>The word is spelled <textEntryInteraction responseIdentifier="RESPONSE" expectedLength="10"/> in America.</p>',
      declared('single', 'string', ['color'], `<mapping defaultValue="0"><mapEntry mapKey="color" mappedValue="1"${caseSensitive}/><mapEntry mapKey="colour" mappedValue="1"${caseSensitive}/><mapEntry mapKey="colr" mappedValue="0"${caseSensitive}/></mapping>`));
    // QTI matches a typed response with its letter case, unless the mapping's entries say not to.
    expect(one(entry(''))).toEqual({ question: 'The word is spelled ____ in America.', type: 'fill-in', answer: 'color', accept: ['colour'], caseSensitive: true });
    expect(one(entry(' caseSensitive="false"'))).toEqual({ question: 'The word is spelled ____ in America.', type: 'fill-in', answer: 'color', accept: ['colour'] });
  });

  it('reads letter case from the answers it scores, and leaves out answers that differ in it (Codex, on #575)', () => {
    const entries = (...kinds: Array<[string, number, string]>): string => item('<p>Spell it: <textEntryInteraction responseIdentifier="RESPONSE"/></p>',
      declared('single', 'string', ['color'], `<mapping defaultValue="0">${kinds.map(([key, value, cs]) => `<mapEntry mapKey="${key}" mappedValue="${value}"${cs}/>`).join('')}</mapping>`));
    // An entry that scores nothing is no answer, and says nothing of how answers are matched.
    expect(one(entries(['color', 1, ' caseSensitive="false"'], ['colour', 1, ' caseSensitive="false"'], ['COLR', 0, '']))).toEqual({ question: 'Spell it: ____', type: 'fill-in', answer: 'color', accept: ['colour'] });
    expect(one(entries(['color', 1, ' caseSensitive="false"'], ['colour', 1, ' caseSensitive="true"'])))
      .toBe('item "q1": its answers differ in whether letter case counts, and a question here grades them one way');
    // A correct response no entry scores is matched exactly, so beside answers read without case it differs.
    expect(one(entries(['colour', 1, ' caseSensitive="false"']))).toMatch(/differ in whether letter case counts/);
  });

  it('counts a correct response an entry scores by that entry\'s own rule, and an answer another already accepts as nothing more (Codex, on #576)', () => {
    const upper = item('<p>Spell it: <textEntryInteraction responseIdentifier="RESPONSE"/></p>',
      declared('single', 'string', ['COLOR'], '<mapping defaultValue="0"><mapEntry mapKey="color" mappedValue="1" caseSensitive="false"/></mapping>'));
    expect(one(upper)).toEqual({ question: 'Spell it: ____', type: 'fill-in', answer: 'COLOR', accept: ['color'] });
    // A strict entry that a loose one already accepts adds nothing: the question is read without case.
    const both = item('<p>Spell it: <textEntryInteraction responseIdentifier="RESPONSE"/></p>',
      declared('single', 'string', ['color'], '<mapping defaultValue="0"><mapEntry mapKey="Color" mappedValue="1" caseSensitive="true"/><mapEntry mapKey="color" mappedValue="1" caseSensitive="false"/></mapping>'));
    expect(one(both)).toEqual({ question: 'Spell it: ____', type: 'fill-in', answer: 'color', accept: ['Color'] });
  });

  it('leaves out an item whose prompt shows an image, a formula or media, as it does a stem that does (Codex, on #572)', () => {
    const options = '<simpleChoice identifier="A">a</simpleChoice><simpleChoice identifier="B">b</simpleChoice>';
    expect(one(item(`<choiceInteraction responseIdentifier="RESPONSE" maxChoices="1"><prompt>Which is shown? <img src="x.png" alt="x"/></prompt>${options}</choiceInteraction>`, declared('single', 'identifier', ['A']))))
      .toBe('item "q1": its question shows an image, a formula or media, which a check here would not show');
    expect(one(item(`<orderInteraction responseIdentifier="RESPONSE"><prompt>Order by <math><mi>x</mi></math>.</prompt>${options}</orderInteraction>`, declared('ordered', 'identifier', ['A', 'B']))))
      .toMatch(/shows an image, a formula or media/);
  });

  it('reads a numeric text entry as numeric, and an inline choice as a choice', () => {
    expect(one(item('<p>2 + 2.5 = <textEntryInteraction responseIdentifier="RESPONSE"/></p>', declared('single', 'float', ['4.5']))))
      .toEqual({ question: '2 + 2.5 = ____', type: 'numeric', answer: 4.5 });
    expect(one(item('<p>Water boils at <inlineChoiceInteraction responseIdentifier="RESPONSE"><inlineChoice identifier="x">90</inlineChoice><inlineChoice identifier="y">100</inlineChoice></inlineChoiceInteraction> degrees.</p>',
      declared('single', 'identifier', ['y'])))).toEqual({ question: 'Water boils at ____ degrees.', type: 'choice', options: ['90', '100'], answer: 'B' });
  });

  it('reads an order as sequencing, its items in the order its correct response gives', () => {
    const xml = item('<orderInteraction responseIdentifier="RESPONSE"><prompt>Put them in order.</prompt><simpleChoice identifier="c">Third</simpleChoice><simpleChoice identifier="a">First</simpleChoice><simpleChoice identifier="b">Second</simpleChoice></orderInteraction>',
      declared('ordered', 'identifier', ['a', 'b', 'c']));
    expect(one(xml)).toEqual({ question: 'Put them in order.', type: 'sequencing', items: ['First', 'Second', 'Third'] });
  });

  it('reads a match as matching pairs, a target nothing pairs with as a distractor', () => {
    const xml = item('<matchInteraction responseIdentifier="RESPONSE" maxAssociations="2"><prompt>Match each to its capital.</prompt>'
      + '<simpleMatchSet><simpleAssociableChoice identifier="F" matchMax="1">France</simpleAssociableChoice><simpleAssociableChoice identifier="S" matchMax="1">Spain</simpleAssociableChoice></simpleMatchSet>'
      + '<simpleMatchSet><simpleAssociableChoice identifier="P" matchMax="1">Paris</simpleAssociableChoice><simpleAssociableChoice identifier="M" matchMax="1">Madrid</simpleAssociableChoice><simpleAssociableChoice identifier="R" matchMax="1">Rome</simpleAssociableChoice></simpleMatchSet></matchInteraction>',
    declared('multiple', 'directedPair', ['F P', 'S M']));
    expect(one(xml)).toEqual({ question: 'Match each to its capital.', type: 'matching', pairs: [['France', 'Paris'], ['Spain', 'Madrid']], distractors: ['Rome'] });
  });

  it('leaves out what it would have to guess, and says why', () => {
    const choice = '<choiceInteraction responseIdentifier="RESPONSE" maxChoices="1"><simpleChoice identifier="A">a</simpleChoice><simpleChoice identifier="B">b</simpleChoice></choiceInteraction>';
    expect(one(item(`<p>Pick.</p>${choice}`, '<responseDeclaration identifier="RESPONSE" cardinality="single" baseType="identifier"/>'))).toBe('item "q1": it declares no correct response');
    expect(one(item(`<p>Pick.</p>${choice}`, '<responseDeclaration identifier="RESPONSE" cardinality="single" baseType="identifier"><mapping><mapEntry mapKey="A" mappedValue="1"/></mapping></responseDeclaration>')))
      .toBe('item "q1": it is scored by a mapping and declares no correct response');
    expect(one(item(`<p>What is shown? <img src="x.png" alt="x"/></p>${choice}`, declared('single', 'identifier', ['A'])))).toMatch(/shows an image/);
    expect(one(item(`<p>Pick.</p>${choice}${choice}`, declared('single', 'identifier', ['A'])))).toMatch(/2 interactions/);
    expect(one(item(`<p>Pick.</p>${choice}`, declared('single', 'identifier', ['Z'])))).toMatch(/names an option it does not have/);
    expect(one(item('<extendedTextInteraction responseIdentifier="RESPONSE"><prompt>Discuss.</prompt></extendedTextInteraction>', '<responseDeclaration identifier="RESPONSE" cardinality="single" baseType="string"/>')))
      .toMatch(/recorded rather than graded/);
    expect(one(item('<hotspotInteraction responseIdentifier="RESPONSE"><prompt>Where?</prompt></hotspotInteraction>', declared('single', 'identifier', ['A'])))).toMatch(/a hotspot interaction, which this does not read/);
    // A question an author could not write is not kept either: one option only.
    expect(one(item('<choiceInteraction responseIdentifier="RESPONSE"><prompt>Only?</prompt><simpleChoice identifier="A">a</simpleChoice></choiceInteraction>', declared('single', 'identifier', ['A'])))).toMatch(/options needs 2/);
  });

  it('is not what a test that only refers to its items is, nor a file that is not QTI', () => {
    expect(qtiQuestions('<assessmentTest identifier="t"><testPart><assessmentSection><assessmentItemRef href="q.xml"/></assessmentSection></testPart></assessmentTest>', 't.xml')).toBeNull();
    expect(qtiQuestions('<?xml version="1.0"?><lom><general/></lom>', 'meta.xml')).toBeNull();
  });
});

describe('a QTI 3 item', () => {
  it('is read as QTI 2 is: its elements and attributes renamed, their meaning kept', () => {
    const xml = '<qti-assessment-item xmlns="http://www.imsglobal.org/spec/qti/v3p0/imsqti_asiv3p0_v1p0" identifier="q3" title="T">'
      + '<qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier"><qti-correct-response><qti-value>B</qti-value></qti-correct-response></qti-response-declaration>'
      + '<qti-item-body><qti-choice-interaction response-identifier="RESPONSE" max-choices="1"><qti-prompt>Which is a mammal?</qti-prompt>'
      + '<qti-simple-choice identifier="A">Shark</qti-simple-choice><qti-simple-choice identifier="B">Whale</qti-simple-choice></qti-choice-interaction></qti-item-body></qti-assessment-item>';
    expect(one(xml)).toEqual({ question: 'Which is a mammal?', type: 'choice', options: ['Shark', 'Whale'], answer: 'B' });
  });
});

describe('a QTI 1.2 item', () => {
  const qti12 = (body: string): string => `<?xml version="1.0"?><questestinterop><assessment ident="a"><section ident="s">${body}</section></assessment></questestinterop>`;
  const labels = '<render_choice><response_label ident="A"><material><mattext>Mercury</mattext></material></response_label>'
    + '<response_label ident="B"><material><mattext>Venus</mattext></material></response_label><response_label ident="C"><material><mattext>Mars</mattext></material></response_label></render_choice>';
  const scored = (ident: string, value: string): string => `<respcondition><conditionvar><varequal respident="${ident}">${value}</varequal></conditionvar><setvar action="Set" varname="SCORE">100</setvar></respcondition>`;

  it('reads a choice by the condition that scores it, its text as HTML when it is written so', () => {
    const xml = qti12('<item ident="p1"><presentation><material><mattext texttype="text/html">&lt;p&gt;Which is &lt;b&gt;closest&lt;/b&gt; to the Sun?&lt;/p&gt;</mattext></material>'
      + `<response_lid ident="R" rcardinality="Single">${labels}</response_lid></presentation>`
      + `<resprocessing><outcomes><decvar/></outcomes>${scored('R', 'A')}<respcondition><conditionvar><not><varequal respident="R">A</varequal></not></conditionvar><setvar action="Set" varname="SCORE">0</setvar></respcondition></resprocessing></item>`);
    expect(one(xml)).toEqual({ question: 'Which is closest to the Sun?', type: 'choice', options: ['Mercury', 'Venus', 'Mars'], answer: 'A' });
  });

  it('reads several scoring conditions of a multiple response as its right options', () => {
    const xml = qti12(`<item ident="p2"><presentation><material><mattext>Which are inner planets?</mattext></material><response_lid ident="R" rcardinality="Multiple">${labels}</response_lid></presentation>`
      + `<resprocessing>${scored('R', 'A').replace('100', '1')}${scored('R', 'C').replace('100', '1')}</resprocessing></item>`);
    expect(one(xml)).toEqual({ question: 'Which are inner planets?', type: 'choice', options: ['Mercury', 'Venus', 'Mars'], answer: ['A', 'C'], multiple: true });
  });

  it('reads a string response as fill-in and a numeric one as numeric, and leaves out an image', () => {
    expect(one(qti12(`<item ident="s"><presentation><material><mattext>Red planet?</mattext></material><response_str ident="R"><render_fib/></response_str></presentation><resprocessing>${scored('R', 'Mars')}${scored('R', 'mars')}</resprocessing></item>`)))
      .toEqual({ question: 'Red planet?', type: 'fill-in', answer: 'Mars', accept: ['mars'] });
    expect(one(qti12(`<item ident="n"><presentation><material><mattext>Planets?</mattext></material><response_num ident="R"><render_fib/></response_num></presentation><resprocessing>${scored('R', '8')}</resprocessing></item>`)))
      .toEqual({ question: 'Planets?', type: 'numeric', answer: 8 });
    expect(one(qti12(`<item ident="i"><presentation><material><mattext>This one?</mattext><matimage uri="p.png"/></material><response_lid ident="R">${labels}</response_lid></presentation><resprocessing>${scored('R', 'A')}</resprocessing></item>`)))
      .toMatch(/shows an image/);
    expect(one(qti12(`<item ident="z"><presentation><material><mattext>Which?</mattext></material><response_lid ident="R">${labels}</response_lid></presentation></item>`)))
      .toBe('item "z": no condition that scores it names a correct response');
  });

  it('counts only a condition that sets the score it declares, not another outcome (Codex, on #572)', () => {
    const noted = (value: string): string => `<respcondition><conditionvar><varequal respident="R">${value}</varequal></conditionvar><setvar action="Set" varname="FEEDBACK">1</setvar></respcondition>`;
    const lid = (resprocessing: string): string => qti12(`<item ident="o"><presentation><material><mattext>Hottest planet?</mattext></material><response_lid ident="R" rcardinality="Single">${labels}</response_lid></presentation><resprocessing>${resprocessing}</resprocessing></item>`);
    expect(one(lid(`<outcomes><decvar varname="SCORE"/><decvar varname="FEEDBACK"/></outcomes>${noted('A')}${scored('R', 'B')}`))).toMatchObject({ answer: 'B' });
    // An item may name its score otherwise; what it names is what counts.
    expect(one(lid(`<outcomes><decvar varname="POINTS"/></outcomes>${scored('R', 'C').replace('SCORE', 'POINTS')}${scored('R', 'A')}`))).toMatchObject({ answer: 'C' });
  });

  it('reads a typed response with its letter case where a condition compares with it', () => {
    const str = (compare: string): unknown => one(qti12(`<item ident="c"><presentation><material><mattext>Red planet?</mattext></material><response_str ident="R"><render_fib/></response_str></presentation>`
      + `<resprocessing><respcondition><conditionvar><varequal respident="R"${compare}>Mars</varequal></conditionvar><setvar action="Set">1</setvar></respcondition></resprocessing></item>`));
    expect(str(' case="Yes"')).toEqual({ question: 'Red planet?', type: 'fill-in', answer: 'Mars', caseSensitive: true });
    expect(str('')).toEqual({ question: 'Red planet?', type: 'fill-in', answer: 'Mars' });
  });

  it('leaves out a typed response whose scoring conditions differ in whether letter case counts (Codex, on #575)', () => {
    const condition = (value: string, compare: string): string => `<respcondition><conditionvar><varequal respident="R"${compare}>${value}</varequal></conditionvar><setvar action="Set">1</setvar></respcondition>`;
    const str = (conditions: string): unknown => one(qti12(`<item ident="m"><presentation><material><mattext>A rocky planet?</mattext></material><response_str ident="R"><render_fib/></response_str></presentation><resprocessing>${conditions}</resprocessing></item>`));
    expect(str(condition('Mars', ' case="Yes"') + condition('Venus', ''))).toBe('item "m": its answers differ in whether letter case counts, and a question here grades them one way');
    expect(str(condition('Mars', ' case="Yes"') + condition('Venus', ' case="Yes"'))).toEqual({ question: 'A rocky planet?', type: 'fill-in', answer: 'Mars', accept: ['Venus'], caseSensitive: true });
    // A strict condition that a loose one for the same answer already covers adds nothing (Codex, on #576).
    expect(str(condition('Mars', ' case="Yes"') + condition('Mars', ''))).toEqual({ question: 'A rocky planet?', type: 'fill-in', answer: 'Mars' });
  });
});

describe('a bank kept as data', () => {
  it('reads options as text, the answer as an option\'s text or its letter', () => {
    const read = dataQuestions([
      { question: 'Largest ocean?', options: ['Atlantic', 'Pacific'], answer: 'Pacific' },
      { prompt: '<p>Smallest <em>continent</em>?</p>', choices: ['Asia', 'Australia'], correct: 'B' },
    ], 'bank.json');
    expect(read).toEqual({ questions: [
      { question: 'Largest ocean?', type: 'choice', options: ['Atlantic', 'Pacific'], answer: 'B' },
      { question: 'Smallest continent?', type: 'choice', options: ['Asia', 'Australia'], answer: 'B' },
    ], unread: [] });
  });

  it('reads options that flag whether they are right, and keeps a multiple-response type', () => {
    const read = dataQuestions({ quiz: { sections: [
      { questions: [{ question: 'Which are metals?', type: 'Multiple Response', answers: [{ text: 'Iron', isCorrect: true }, { text: 'Oxygen', isCorrect: false }, { text: 'Gold', correct: true }] }] },
      { questions: [{ question: 'Is water wet?', answer: true }, { questionText: 'Boiling point in C?', correct_answer: 100 }, { stem: 'Capital of Italy?', answer: 'Rome', accept: ['rome'] }] },
    ] } }, 'quiz.json');
    expect(read?.unread).toEqual([]);
    expect(read?.questions).toEqual([
      { question: 'Which are metals?', type: 'choice', options: ['Iron', 'Oxygen', 'Gold'], answer: ['A', 'C'], multiple: true },
      { question: 'Is water wet?', type: 'true-false', answer: true },
      { question: 'Boiling point in C?', type: 'numeric', answer: 100 },
      { question: 'Capital of Italy?', type: 'fill-in', answer: 'Rome', accept: ['rome'] },
    ]);
  });

  it('leaves out what its fields do not say, and says why', () => {
    const read = dataQuestions([
      { question: 'Which?', options: ['a', 'b'], answer: 1 },
      { question: 'Which?', options: ['a', 'b'], correctIndex: 0 },
      { question: 'Order them', type: 'sequencing', items: ['x', 'y'] },
      { question: 'Explain.', type: 'essay' },
      { question: 'Shown? <img src="a.png">', answer: 'yes' },
      { question: 'Odd?', type: 'hotspot', answer: 'x' },
      // A declared choice is graded as one or not at all, never as typed text (Codex, on #572).
      { question: 'Capital?', type: 'choice', answer: 'Paris' },
      { question: 'Capitals?', type: 'multiple-response', options: 'Paris, Rome', answer: 'Paris' },
    ], 'b.json');
    expect(read?.questions).toEqual([]);
    expect(read?.unread.map(u => u.why)).toEqual([
      'question 1: its answer is a number, and whether that counts the options from 0 or from 1 is not said',
      'question 2: its answer is an index, and whether that counts the options from 0 or from 1 is not said',
      'question 3: a sequencing question kept as data is not read; the standard\'s form of one (QTI) is',
      'question 4: it asks for an answer that is recorded rather than graded, so it is left for a reflection written here',
      'question 5: its question shows an image, a formula or media, which a check here would not show',
      'question 6: it is a "hotspot" question, which is not read',
      'question 7: it is declared a choice, and gives no list of options',
      'question 8: it is declared a choice, and gives no list of options',
    ]);
  });

  it('is not what a list of other things is', () => {
    expect(dataQuestions([{ text: 'Home', href: '/' }, { text: 'About', href: '/about' }], 'menu.json')).toBeNull();
    expect(dataQuestions({ name: 'package', version: '1.0.0', files: ['a.js'] }, 'package.json')).toBeNull();
  });
});

describe('a bank written out in a script', () => {
  it('is read from its array of objects, its own option lists not read again as banks', () => {
    const script = `// a quiz\nvar quiz = [\n  { question: "Q1?", choices: ["x", "y"], answer: "y" },\n  { 'prompt': 'Q2 is true', answer: true },\n];\n`
      + `var menu = [{ text: 'Home' }];\nfunction grade() { return [ { question: 'not written out', answer: someVar } ]; }`;
    const banks = literalBanks(script, 'topic/quiz.js');
    expect(banks).toHaveLength(2);
    expect(banks[0]!.questions).toEqual([
      { question: 'Q1?', type: 'choice', options: ['x', 'y'], answer: 'B' },
      { question: 'Q2 is true', type: 'true-false', answer: true },
    ]);
    // A value the script names rather than writes out is not guessed at.
    expect(banks[1]).toEqual({ questions: [], unread: [{ path: 'topic/quiz.js', why: 'question 1: it gives no answer' }] });
  });
});

describe('a package keeping its banks in these forms', () => {
  const manifest = '<?xml version="1.0"?><manifest identifier="m" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"><organizations default="o"><organization identifier="o"><title>Planets</title>'
    + '<item identifier="i" identifierref="r"><title>Inner planets</title></item></organization></organizations>'
    + '<resources><resource identifier="r" type="webcontent" href="inner/page.html"><file href="inner/page.html"/><file href="inner/item1.xml"/></resource></resources></manifest>';
  const zip = new AdmZip();
  const add = (name: string, body: string): void => { zip.addFile(name, Buffer.from(body, 'utf8')); };
  add('imsmanifest.xml', manifest);
  add('inner/page.html', '<html><head><title>Inner</title></head><body><h1>The inner planets</h1><p>Mercury, Venus, Earth and Mars.</p><script src="bank.js"></script></body></html>');
  add('inner/bank.js', 'var bank = [{ question: "How many inner planets are there?", answer: 4 }];');
  add('inner/item1.xml', item('<choiceInteraction responseIdentifier="RESPONSE" maxChoices="1"><prompt>Which is largest?</prompt><simpleChoice identifier="A">Mars</simpleChoice><simpleChoice identifier="B">Earth</simpleChoice></choiceInteraction>', declared('single', 'identifier', ['B'])));
  add('assets/extra.json', JSON.stringify({ questions: [{ question: 'Is Mars red?', answer: true }, { question: 'Which?', options: ['a', 'b'], answer: 0 }] }));
  const pkg = readPackage(filesOfZip(zip), { fileUrl: p => `https://bridge.example/files/${p}` });

  it('reads each bank into its topic: a folder\'s, and one kept with the chrome on its own', () => {
    expect(pkg.topics.map(t => [t.id, t.title, t.pages.length, t.questions.length])).toEqual([
      ['inner', 'Inner planets', 1, 2],
      ['extra.json', 'Extra', 0, 1],
    ]);
    expect(pkg.topics[0]!.questions).toEqual([
      { question: 'Which is largest?', type: 'choice', options: ['Mars', 'Earth'], answer: 'B' },
      { question: 'How many inner planets are there?', type: 'numeric', answer: 4 },
    ]);
    expect(pkg.unread).toEqual([{ path: 'assets/extra.json', why: 'question 2: its answer is a number, and whether that counts the options from 0 or from 1 is not said' }]);
  });

  it('folds each topic\'s questions into a check graded as the bank says is right', () => {
    const folded = foldPackage(pkg, { competency: 'planets', blindFor: t => t.length.toString(16).padStart(64, '0') });
    const byId = new Map(folded.items.map(i => [i['@id'], i]));
    const check = byId.get(folded.topics[0]!.check!) as Fragment;
    const asked = (check.questions ?? []) as ScormAssessmentQuestion[];
    expect(asked).toHaveLength(2);
    expect(questionIsRight('B', asked[0]!)).toBe(true);
    expect(questionIsRight('A', asked[0]!)).toBe(false);
    expect(questionIsRight('4', asked[1]!)).toBe(true);
    const extra = byId.get(folded.topics[1]!.check!) as Fragment;
    expect(questionIsRight('true', (extra.questions ?? [])[0] as ScormAssessmentQuestion)).toBe(true);
  });
});

describe('sequencing and matching, as the learner answers them', () => {
  it('grade the right order and the right pairs, whatever order they are shown in', () => {
    const read = qtiQuestions([
      item('<orderInteraction responseIdentifier="RESPONSE"><prompt>Order.</prompt><simpleChoice identifier="a">One</simpleChoice><simpleChoice identifier="b">Two</simpleChoice><simpleChoice identifier="c">Three</simpleChoice></orderInteraction>',
        declared('ordered', 'identifier', ['a', 'b', 'c']), 'o'),
    ].join(''), 'o.xml')!;
    const pkgZip = new AdmZip();
    pkgZip.addFile('imsmanifest.xml', Buffer.from('<?xml version="1.0"?><manifest identifier="m"><organizations/><resources><resource identifier="r" href="t/p.html"><file href="t/p.html"/></resource></resources></manifest>'));
    pkgZip.addFile('t/p.html', Buffer.from('<html><body><h1>T</h1><p>text</p></body></html>'));
    pkgZip.addFile('t/o.xml', Buffer.from(item('<orderInteraction responseIdentifier="RESPONSE"><prompt>Order.</prompt><simpleChoice identifier="a">One</simpleChoice><simpleChoice identifier="b">Two</simpleChoice><simpleChoice identifier="c">Three</simpleChoice></orderInteraction>', declared('ordered', 'identifier', ['a', 'b', 'c']))));
    const folded = foldPackage(readPackage(filesOfZip(pkgZip), { fileUrl: p => p }), { competency: 'order', blindFor: () => '0'.repeat(64) });
    const check = folded.items.find(i => i['@id'] === folded.topics[0]!.check) as Fragment;
    const q = (check.questions ?? [])[0] as ScormAssessmentQuestion & { input: { items: string[] } };
    expect(read.questions[0]).toEqual({ question: 'Order.', type: 'sequencing', items: ['One', 'Two', 'Three'] });
    // The reply names the shown items, by their letters, in their right order.
    const right = ['One', 'Two', 'Three'].map(t => String.fromCharCode(65 + q.input.items.indexOf(t))).join(', ');
    expect(questionIsRight(right, q)).toBe(true);
    expect(questionIsRight(right.split(', ').reverse().join(', '), q)).toBe(false);
  });
});
