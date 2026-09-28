/**
 * A SCORM package hosted here folds into Foxxi's content model: its pages become concept fragments
 * in Markdown, the questions it declares in its own scripts become checks graded on this bridge,
 * each folder of pages a topic composition, and the package a composition of its topics
 * (src/package-import.ts, reached through POST /agent/content/fold-course with package_sha256).
 *
 * ★ WHY. A package from any authoring tool could be hosted and played whole, but not taken apart:
 * nothing of it could be resolved per learner, offered another way in at one position, or measured
 * for what works. Folded, it can be, and what was not read is said rather than guessed.
 *
 * Here: the page reader (HTML to the Markdown course-markdown.ts renders), a page's charset, the
 * question reader against the package's own declarations, the golf sample in imported/ read and
 * folded whole, packages made to show ordering, titles, links and what is left out, the fold's
 * limits and errors, and the route's wiring.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import AdmZip from 'adm-zip';
import {
  PACKAGE_FOLD_LIMITS, PackageError, decodeEntities, filesOfZip, foldPackage, htmlPage, pageText, questionCalls, questionForm,
  questionOf, readPackage, type ImportedPackage, type Literal, type QuestionForm,
} from '../src/package-import.js';
import { ContentError, FRAGMENT_LIMITS, type Fragment } from '../src/content-fragments.js';
import { courseMarkdownHtml } from '../src/course-markdown.js';
import { questionIsRight } from '../src/course-questions.js';
import type { Composition } from '../src/compositions.js';
import { foldedPackageFrom } from '../dashboard-app/src/author/package-fold.js';

const FILES = 'https://bridge.example/scorm/packages/abc/files/';
const fileUrl = (path: string): string => `${FILES}${path.split('/').map(encodeURIComponent).join('/')}`;
const BACKSLASH = String.fromCharCode(92);

describe('a page, read as Markdown', () => {
  it('takes its first top-level heading as its title, and its other headings one level down', () => {
    const page = htmlPage('<html><head><title>Doc title</title></head><body><h1>Care for <b>the</b> course</h1><h2>Carts</h2><p>Park them.</p><h3>Speed</h3><p>Go slowly.</p><h1>Second top</h1></body></html>');
    expect(page.title).toBe('Care for the course');
    expect(page.body).toBe('# Carts\n\nPark them.\n\n## Speed\n\nGo slowly.\n\n# Second top');
    // Rendered, a page's own headings sit under its title, which the fragment shows.
    expect(courseMarkdownHtml(page.body)).toContain('<h2>Carts</h2>');
    // With no top-level heading, the document's title; with neither, none.
    expect(htmlPage('<title>Only &amp; this</title><p>x</p>').title).toBe('Only & this');
    expect(htmlPage('<p>x</p>').title).toBeUndefined();
  });

  it('writes each paragraph on one line, a line break as one, with its whitespace and references resolved', () => {
    const page = htmlPage('<body><p>Golf   carts\n  are a\tluxury&nbsp;even.</p><p>One<br>two<br/>three</p><p>caf&eacute; &#8212; &#x2014; &#150; &yuml; &bogus; &lt;b&gt;</p></body>');
    expect(page.body).toBe(`Golf carts are a luxury even.\n\nOne\ntwo\nthree\n\ncafé — — – ÿ &bogus; <b>`);
    // A character reference to markup is text: the renderer escapes it.
    expect(courseMarkdownHtml(page.body)).toContain('&lt;b&gt;');
  });

  it('keeps lists, emphasis, code, quotes, rules and preformatted text as Markdown', () => {
    const page = htmlPage('<body><ul><li>one</li><li>two <ul><li>nested</li></ul></li></ul><ol start="3"><li>three</li><li>four</li></ol>'
      + '<p>A <strong> bold </strong>word, an <em>aside</em>, <code>x = 1</code> and <i>a*b</i>.</p><blockquote><p>Quoted.</p></blockquote><hr>'
      + '<pre>  line one\n    line two</pre><pre>has ``` in it</pre></body>');
    expect(page.body).toBe([
      '- one\n- two\n- nested',
      '3. three\n4. four',
      `A **bold** word, an *aside*, \`x = 1\` and *a${BACKSLASH}*b*.`,
      '> Quoted.',
      '---',
      '```\n  line one\n    line two\n```',
      '~~~\nhas ``` in it\n~~~',
    ].join('\n\n'));
    const html = courseMarkdownHtml(page.body);
    expect(html).toContain('and <em>a*b</em>.');
    expect(html).toContain('<ul><li>one</li><li>two</li><li>nested</li></ul>');
    expect(html).toContain('<ol start="3"><li>three</li><li>four</li></ol>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<blockquote><p>Quoted.</p></blockquote>');
  });

  it('keeps a web link and a web image, and by default only the text of any other link, and no other image', () => {
    const page = htmlPage('<body><p>See <a href="https://example.org/rules?a=1">the rules [2019]</a>, <a href="other.html">the next page</a> and <a href="javascript:alert(1)">this</a>.</p>'
      + '<p><img src="https://example.org/a b(1).png" alt="a ]tricky[ alt"> <img src="local.png" alt="gone"> <img src="javascript:x()"></p></body>');
    expect(page.body).toBe(`See [the rules ${BACKSLASH}[2019${BACKSLASH}]](https://example.org/rules?a=1), the next page and this.\n\n![a ${BACKSLASH}]tricky${BACKSLASH}[ alt](https://example.org/a%20b%281%29.png)`);
    const html = courseMarkdownHtml(page.body);
    expect(html).toContain('<a href="https://example.org/rules?a=1"');
    expect(html).toContain('<img src="https://example.org/a%20b%281%29.png" alt="a ]tricky[ alt"');
    expect(html).toContain('>the rules [2019]</a>');
    expect(html).not.toMatch(/javascript:/);
  });

  it('makes a table of rows and columns a table, and reads a table that only lays a page out as paragraphs', () => {
    const page = htmlPage('<body><table><tr><th>Score</th><th>Name</th></tr><tr><td>-2</td><td>Eagle | rare</td></tr><tr><td>-1</td></tr></table>'
      + '<table><tr><td><img src="https://example.org/x.png" alt="x"></td><td><p>Beside the picture.</p></td></tr></table></body>');
    expect(page.body).toBe([
      `| Score | Name |\n| --- | --- |\n| -2 | Eagle ${BACKSLASH}| rare |\n| -1 |  |`,
      '![x](https://example.org/x.png)',
      'Beside the picture.',
    ].join('\n\n'));
    expect(courseMarkdownHtml(page.body)).toContain('<td>Eagle | rare</td>');
  });

  it('leaves out what is not text a reader reads, and keeps the page\'s own scripts for its questions', () => {
    const page = htmlPage('<html><head><script>var inHead = 1;</script></head><body><!-- a comment --><script>test.AddQuestion(new Question("q"));</script><script src="lib.js"></script>'
      + '<style>p { color: red }</style><noscript>Enable JavaScript</noscript><button>Next</button><select><option>A</option></select>'
      + '<svg><text>drawn</text></svg><p>Kept.</p><input type="radio"> Label kept</body></html>');
    expect(page.body).toBe('Kept.\n\nLabel kept');
    expect(page.scripts).toEqual(['var inHead = 1;', 'test.AddQuestion(new Question("q"));']);
    expect(page.scriptSrcs).toEqual(['lib.js']);
  });

  it('says what the page says: text that looks like Markdown is shown as it is written (Codex, on #553)', () => {
    const page = htmlPage('<body><p>- Important</p><p>*literal* and **not bold** and `not code`</p><p>1. Not numbered</p><p># Not a heading</p>'
      + '<p>&gt; Not a quote</p><p>---</p><p>[not](a link) and snake_case and _edge_ and a \\ backslash</p><p>One<br>- two</p></body>');
    const html = courseMarkdownHtml(page.body);
    expect(html).toBe([
      '<p>- Important</p>', '<p>*literal* and **not bold** and `not code`</p>', '<p>1. Not numbered</p>', '<p># Not a heading</p>',
      '<p>&gt; Not a quote</p>', '<p>---</p>', '<p>[not](a link) and snake_case and _edge_ and a \\ backslash</p>', '<p>One<br>- two</p>',
    ].join('\n'));
    // An underscore inside a word is no syntax, and the source stays as it was written there.
    expect(page.body).toContain('snake_case');
  });

  it('decodes each character reference once, and leaves one that names nothing as it is', () => {
    expect(decodeEntities('&amp;lt; &Agrave;&iquest;&yuml; &#0; &#xD800; &constructor;')).toBe(`&lt; À¿ÿ ${String.fromCharCode(0xfffd)} ${String.fromCharCode(0xfffd)} &constructor;`);
  });
});

describe('a page\'s text', () => {
  it('is read in the charset it declares, else as UTF-8, else as windows-1252', () => {
    const e = Buffer.from([0xe9]);
    const declared = Buffer.concat([Buffer.from('<meta charset="windows-1252"><p>caf'), e, Buffer.from('</p>')]);
    expect(pageText(declared)).toContain('café');
    // 0xE8 is č in the Latin-2 a page declares, where windows-1252 would read è.
    expect(pageText(Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-2"><p>'), Buffer.from([0xe8]), Buffer.from('</p>')]))).toContain('<p>č</p>');
    expect(pageText(Buffer.from('<p>café</p>', 'utf8'))).toBe('<p>café</p>');
    // Bytes that are not UTF-8, declaring nothing, are read as the web reads them: 0x93 is a quote
    // mark there, not the control character Latin-1 makes it.
    expect(pageText(Buffer.concat([Buffer.from('<p>caf'), e, Buffer.from([0x20, 0x93]), Buffer.from('</p>')]))).toBe('<p>café “</p>');
    expect(pageText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<p>x</p>')]))).toBe('<p>x</p>');
  });
});

const FORM: QuestionForm = {
  params: ['id', 'text', 'type', 'answers', 'correctAnswer', 'objectiveId'],
  constants: new Map([['QUESTION_TYPE_CHOICE', 'choice'], ['QUESTION_TYPE_TF', 'true-false'], ['QUESTION_TYPE_NUMERIC', 'numeric'], ['QUESTION_TYPE_LIKERT', 'likert']]),
};
const str = (v: string): Literal => ({ k: 'str', v });
const id = (v: string): Literal => ({ k: 'id', v });

describe('the questions a package declares', () => {
  it('are the values of each `new Question(…)` call, written out: strings, numbers, booleans, arrays', () => {
    const script = [
      'test.AddQuestion( new Question ("q1", "Stand where?", QUESTION_TYPE_CHOICE, new Array("Here", "There"), "There", "obj") );',
      `test.AddQuestion(new Question('q2', "It's " + '${BACKSLASH}'fine${BACKSLASH}' ${BACKSLASH}x41 ${BACKSLASH}u0042' /* a comment */, QUESTION_TYPE_TF, null, true, 'obj'));`,
      'test.AddQuestion(new Question("q3", "Holes?", QUESTION_TYPE_NUMERIC, [], 18, "obj",));',
      'test.AddQuestion(new Question("q4", textOf(4), QUESTION_TYPE_TF, null, true, "obj"));',
      'function Question(id, text) { this.Id = id; }',
    ].join('\n');
    const calls = questionCalls(script);
    expect(calls).toHaveLength(4);
    expect(calls[0]).toEqual([str('q1'), str('Stand where?'), id('QUESTION_TYPE_CHOICE'), { k: 'arr', v: [str('Here'), str('There')] }, str('There'), str('obj')]);
    expect(calls[1]![1]).toEqual(str("It's 'fine' A B"));
    expect(calls[1]![4]).toEqual({ k: 'bool', v: true });
    expect(calls[2]![3]).toEqual({ k: 'arr', v: [] });
    expect(calls[2]![4]).toEqual({ k: 'num', v: 18 });
    // An argument that is not a value written out: the call is not read.
    expect(calls[3]).toBeNull();
  });

  it('are only calls the script runs: none written in a comment or inside a string (Codex, on #553)', () => {
    const script = [
      '// test.AddQuestion(new Question("c1", "In a line comment?", QUESTION_TYPE_TF, null, true, "o"));',
      '/* test.AddQuestion(new Question("c2", "In a block comment?", QUESTION_TYPE_TF, null, true, "o")); */',
      'var example = "new Question(\'s1\', \'In a string?\', QUESTION_TYPE_TF, null, true, \'o\')";',
      'var shown = `new Question("t1", "In a template?", QUESTION_TYPE_TF, null, true, "o")`;',
      'test.AddQuestion(new Question("real", "Is this one asked?", QUESTION_TYPE_TF, null, true, "o"));',
    ].join('\n');
    expect(questionCalls(script).map(c => c?.[0])).toEqual([str('real')]);
    // A constructor declared only in a comment declares nothing.
    expect(questionForm(['// function Question(id, text, type, answers, correctAnswer) {}'])).toBeNull();
  });

  it('are read by the parameter names and constants the package itself declares', () => {
    const form = questionForm([
      'var QUESTION_TYPE_CHOICE = "choice";\nvar QUESTION_TYPE_TF = "true-false";\nfunction Question(id, text, type, answers, correctAnswer, objectiveId){ this.Id = id; }',
      "const OTHER = 'x';",
    ]);
    expect(form?.params).toEqual(['id', 'text', 'type', 'answers', 'correctAnswer', 'objectiveId']);
    expect(Object.fromEntries(form!.constants)).toEqual({ QUESTION_TYPE_CHOICE: 'choice', QUESTION_TYPE_TF: 'true-false', OTHER: 'x' });
    expect(questionForm(['var A = "a";'])).toBeNull();
  });

  it('become questions as an author writes them, or say why not', () => {
    const q = (...args: Literal[]): ReturnType<typeof questionOf> => questionOf(args, FORM);
    expect(q(str('1'), str('Where?'), id('QUESTION_TYPE_CHOICE'), { k: 'arr', v: [str('Here'), str('There')] }, str('There'))).toEqual({ question: 'Where?', type: 'choice', options: ['Here', 'There'], answer: 'There' });
    expect(q(str('2'), str('Rakes outside?'), id('QUESTION_TYPE_TF'), { k: 'null' }, str('True'))).toEqual({ question: 'Rakes outside?', type: 'true-false', answer: true });
    expect(q(str('3'), str('Par?'), str('numeric'), { k: 'null' }, str('3'))).toEqual({ question: 'Par?', type: 'numeric', answer: 3 });
    expect(q(str('4'), str('Where?'), id('QUESTION_TYPE_CHOICE'), { k: 'arr', v: [str('Here')] }, str('Elsewhere'))).toBe('its answer is not one of its options');
    expect(q(str('5'), str('Rate it'), id('QUESTION_TYPE_LIKERT'), { k: 'null' }, str('x'))).toBe('it is a "likert" question, which is not read');
    expect(q(str('6'), str('?'), id('UNDECLARED'), { k: 'null' }, str('x'))).toBe('its type is not one the package names');
    expect(q(str('7'), str('  '), id('QUESTION_TYPE_TF'), { k: 'null' }, { k: 'bool', v: true })).toBe('it has no question text written out');
    expect(q(str('8'), str('Holes?'), id('QUESTION_TYPE_NUMERIC'), { k: 'null' }, str('eighteen'))).toBe('its answer is not a number');
    expect(q(str('9'), str('Sure?'), id('QUESTION_TYPE_TF'), { k: 'null' }, str('maybe'))).toBe('its answer is neither true nor false');
    // It must stand as an authored question does: a question over its length is not one.
    expect(q(str('10'), str('x'.repeat(1001)), id('QUESTION_TYPE_TF'), { k: 'null' }, { k: 'bool', v: true })).toMatch(/question/);
  });
});

/** A zip of the named files. */
function zipOf(files: Record<string, string | Buffer>): AdmZip {
  const zip = new AdmZip();
  for (const [name, body] of Object.entries(files)) zip.addFile(name, typeof body === 'string' ? Buffer.from(body, 'utf8') : body);
  return zip;
}
const manifest = (organization: string, resources: string): string => '<?xml version="1.0"?><manifest identifier="m" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3">'
  + `<organizations default="o"><organization identifier="o">${organization}</organization></organizations><resources>${resources}</resources></manifest>`;
const page = (h1: string, text: string): string => `<html><head><title>${h1}</title></head><body><h1>${h1}</h1><p>${text}</p></body></html>`;

describe('the golf sample, read', () => {
  const golf = readPackage(filesOfZip(new AdmZip(readFileSync(new URL('../imported/golf-explained.zip', import.meta.url)))), { fileUrl });

  it('is its topics in the manifest\'s order, each folder\'s pages and the questions its scripts declare', () => {
    expect(golf.title).toBe('Golf Explained - CP Single SCO');
    expect(golf.topics.map(t => [t.id, t.title, t.pages.length, t.questions.length])).toEqual([
      ['Etiquette', 'Etiquette', 3, 3], ['Handicapping', 'Handicapping', 4, 4], ['HavingFun', 'Having Fun', 2, 3], ['Playing', 'Playing', 5, 5],
    ]);
    expect(golf.topics[0]!.pages.map(p => [p.path, p.title])).toEqual([
      ['Etiquette/Course.html', 'Etiquette - Care For the Course'],
      ['Etiquette/Distracting.html', 'Etiquette - Avoiding Distraction'],
      ['Etiquette/Play.html', 'Etiquette - Playing the Game'],
    ]);
    // The package's shared templates are chrome, and are said to be.
    expect(golf.unread).toEqual([
      { path: 'shared/launchpage.html', why: 'kept with the package\'s shared files: chrome, not a page of teaching' },
      { path: 'shared/assessmenttemplate.html', why: 'kept with the package\'s shared files: chrome, not a page of teaching' },
    ]);
  });

  it('keeps a page\'s text, and shows its images from the package as this bridge hosts it', () => {
    const course = golf.topics[0]!.pages[0]!.body;
    expect(course.startsWith(`![golfing image](${FILES}Etiquette/course.jpg)\n\n# Golf carts\n\nGolf carts are considered a convenience`)).toBe(true);
    expect(course).toContain('# Bunkers');
    expect(course).not.toMatch(/AddLicenseInfo|<script/);
  });

  it('reads each question as the package wrote it: choice, true-false and numeric', () => {
    expect(golf.topics[0]!.questions[0]).toEqual({
      question: 'When another player is attempting a shot, it is best to stand:', type: 'choice',
      options: ['On top of his ball', 'Directly in his line of fire', 'Out of the player\'s line of sight'], answer: 'Out of the player\'s line of sight',
    });
    expect(golf.topics[0]!.questions[1]).toEqual({ question: 'Generally sand trap rakes should be left outside of the hazard', type: 'true-false', answer: true });
    expect(golf.topics[1]!.questions[1]).toMatchObject({ type: 'numeric', answer: 1 });
  });
});

describe('a package, read', () => {
  it('in its organization\'s order, each item\'s launch page and then its files, then any resource no item names', () => {
    const zip = zipOf({
      'imsmanifest.xml': manifest(
        '<title>Two lessons</title><item identifier="i2" identifierref="r2"><title>Lesson two: putting</title></item><item identifier="i1" identifierref="r1"><title>Lesson one: driving</title></item>',
        '<resource identifier="r1" type="webcontent" adlcp:scormType="sco" href="one/index.html"><file href="one/index.html"/><file href="one/more.html"/></resource>'
        + '<resource identifier="r2" type="webcontent" adlcp:scormType="sco" href="two/start.html"><file href="two/start.html"/></resource>'
        + '<resource identifier="extra" type="webcontent" href="About%20this.HTML"/>',
      ),
      'one/index.html': page('Driving', 'Grip the club.'),
      'one/more.html': page('More driving', 'Follow through.'),
      'two/start.html': page('Putting', 'Read the green.'),
      'about this.html': page('About', 'A root page.'),
    });
    const read = readPackage(filesOfZip(zip), { fileUrl });
    expect(read.title).toBe('Two lessons');
    // A folder is titled as the one item whose launch page is in it; a page in no folder is a topic of its own.
    expect(read.topics.map(t => [t.id, t.title, t.pages.map(p => p.title)])).toEqual([
      ['two', 'Lesson two: putting', ['Putting']],
      ['one', 'Lesson one: driving', ['Driving', 'More driving']],
      ['about this.html', 'About', ['About']],
    ]);
  });

  it('keeps a link to a file of the package, and only the text of a link to another of its pages', () => {
    const zip = zipOf({
      'imsmanifest.xml': manifest('<title>Links</title><item identifier="i" identifierref="r"><title>Links</title></item>',
        '<resource identifier="r" type="webcontent" adlcp:scormType="sco" href="a/page.html"><file href="a/page.html"/><file href="a/other.html"/><file href="a/aid (v2).pdf"/></resource>'),
      'a/page.html': '<body><h1>Page</h1><p>Read <a href="other.html#top">the other page</a> or keep <a href="aid%20(v2).pdf">the job aid</a>, <a href="../../../etc/passwd">escape</a>.</p><img src="../a/./missing.png" alt="missing"></body>',
      'a/other.html': page('Other', 'x'),
      'a/aid (v2).pdf': Buffer.from('%PDF'),
    });
    const [topic] = readPackage(filesOfZip(zip), { fileUrl }).topics;
    expect(topic!.pages[0]!.body).toBe(`Read the other page or keep [the job aid](${FILES}a/aid%20%28v2%29.pdf), escape.`);
  });

  it('says what it did not read: a page with no text of its own, and questions it cannot read', () => {
    const zip = zipOf({
      'imsmanifest.xml': manifest('<title>Drawn</title><item identifier="i" identifierref="r"><title>Drawn</title></item>',
        '<resource identifier="r" type="webcontent" adlcp:scormType="sco" href="t/drawn.html"><file href="t/drawn.html"/><file href="t/questions.js"/><file href="t/read.html"/></resource>'),
      't/drawn.html': '<html><body><div id="app"></div><script src="app.js"></script></body></html>',
      't/questions.js': 'test.AddQuestion(new Question("q", "Why?", "choice", ["A"], "A", "o"));',
      't/read.html': page('Read', 'Some text.'),
    });
    const read = readPackage(filesOfZip(zip), { fileUrl });
    expect(read.unread).toEqual([
      { path: 't/drawn.html', why: 'no text of its own: what it shows, its script draws' },
      { path: 't/questions.js', why: 'its questions call a constructor the package does not declare, so which value is which cannot be read' },
    ]);
    expect(read.topics.map(t => t.pages.map(p => p.path))).toEqual([['t/read.html']]);
  });

  it('finds a file named with other casing or percent-encoded, and none outside the package', () => {
    const zip = zipOf({
      'imsmanifest.xml': manifest('<title>Case</title><item identifier="i" identifierref="r"><title>Case</title></item>',
        '<resource identifier="r" type="webcontent" adlcp:scormType="sco" href="Lesson/My%20Page.HTML"><file href="../outside.html"/></resource>'),
      'lesson/my page.html': page('Found', 'By its name, however written.'),
      'outside.html': page('Not listed', 'x'),
    });
    const read = readPackage(filesOfZip(zip), { fileUrl });
    // `../outside.html` resolves within the package, to the file of that name at its root.
    expect(read.topics.map(t => t.pages.map(p => p.path))).toEqual([['lesson/my page.html'], ['outside.html']]);
  });

  it('resolves references under the bases a manifest sets at each level, and none off the package (Codex, on #553)', () => {
    const based = (bases: { manifest?: string; resources?: string; resource?: string }): ImportedPackage => readPackage(filesOfZip(zipOf({
      'imsmanifest.xml': '<?xml version="1.0"?><manifest identifier="m" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3"'
        + `${bases.manifest ? ` xml:base="${bases.manifest}"` : ''}><organizations default="o"><organization identifier="o"><title>Based</title>`
        + '<item identifier="i" identifierref="r"><title>Based</title></item></organization></organizations>'
        + `<resources${bases.resources ? ` xml:base="${bases.resources}"` : ''}><resource identifier="r" type="webcontent" adlcp:scormType="sco" href="start.html"${bases.resource ? ` xml:base="${bases.resource}"` : ''}><file href="start.html"/></resource></resources></manifest>`,
      'course/lessons/one/start.html': page('Nested', 'Under three bases.'),
      'start.html': page('Root', 'At the root.'),
    })), { fileUrl });
    expect(based({ manifest: 'course/', resources: 'lessons/', resource: 'one/' }).topics.map(t => t.pages.map(p => p.path))).toEqual([['course/lessons/one/start.html']]);
    expect(based({}).topics.map(t => t.pages.map(p => p.path))).toEqual([['start.html']]);
    // A base that leads off the package names nothing in it, though a file there has the same path.
    expect(based({ manifest: 'https://cdn.example/course/', resources: 'lessons/', resource: 'one/' }).topics).toEqual([]);
    expect(readPackage(filesOfZip(zipOf({
      'imsmanifest.xml': manifest('<title>Off</title><item identifier="i" identifierref="r"><title>Off</title></item>',
        '<resource identifier="r" type="webcontent" adlcp:scormType="sco" href="https://cdn.example/start.html"><file href="//cdn.example/start.html"/></resource>'),
      'start.html': page('Root', 'x'),
    })), { fileUrl }).topics).toEqual([]);
  });

  it('gives a script\'s questions to the page that loads it, wherever it is kept, and one no page loads to its folder (Codex, on #553)', () => {
    const declaration = 'var QUESTION_TYPE_TF = "true-false"; function Question(id, text, type, answers, correctAnswer) { this.Id = id; }';
    const ask = (id: string) => `test.AddQuestion(new Question("${id}", "Is ${id} asked?", QUESTION_TYPE_TF, null, true));`;
    const read = readPackage(filesOfZip(zipOf({
      'imsmanifest.xml': manifest('<title>Scripts</title><item identifier="i" identifierref="r"><title>Scripts</title></item>',
        '<resource identifier="r" type="webcontent" adlcp:scormType="sco" href="index.html"><file href="index.html"/><file href="js/questions.js"/>'
        + '<file href="lesson/page.html"/><file href="lesson/bank.js"/><file href="js/declare.js"/></resource>'),
      'index.html': '<html><head><title>Start</title><script src="js/declare.js"></script><script src="js/questions.js"></script></head><body><h1>Start</h1><p>Begin here.</p></body></html>',
      'js/declare.js': declaration,
      'js/questions.js': ask('loaded'),
      'lesson/page.html': page('Lesson', 'Read this.'),
      'lesson/bank.js': ask('by-folder'),
    })), { fileUrl });
    expect(read.topics.map(t => [t.id, t.pages.map(p => p.path), t.questions.map(q => q.question)])).toEqual([
      ['index.html', ['index.html'], ['Is loaded asked?']],
      ['lesson', ['lesson/page.html'], ['Is by-folder asked?']],
    ]);
  });

  it('is no package without a manifest', () => {
    expect(() => readPackage(filesOfZip(zipOf({ 'index.html': page('x', 'y') })), { fileUrl })).toThrow(PackageError);
  });
});

describe('a package, folded', () => {
  const golf = readPackage(filesOfZip(new AdmZip(readFileSync(new URL('../imported/golf-explained.zip', import.meta.url)))), { fileUrl });
  const blindFor = (topic: string): string => topic.length.toString(16).padStart(64, '0');
  const folded = foldPackage(golf, { competency: 'golf-basics', blindFor });
  const byId = new Map(folded.items.map(i => [i['@id'], i]));

  it('is a composition of its topics in order, each its pages then its check', () => {
    expect(folded.root.title).toBe('Golf Explained - CP Single SCO');
    expect(folded.root.positions.map(p => p.paradigm[0])).toEqual(folded.topics.map(t => t.at));
    const etiquette = byId.get(folded.topics[0]!.at!) as Composition;
    expect(etiquette.title).toBe('Etiquette');
    expect(etiquette.positions.map(p => p.paradigm[0])).toEqual([...folded.topics[0]!.pages.map(p => p.concept), folded.topics[0]!.check]);
    const concept = byId.get(folded.topics[0]!.pages[0]!.concept) as Fragment;
    expect(concept).toMatchObject({ kind: 'concept', level: 'working', title: 'Etiquette - Care For the Course' });
    expect(concept.body).toBe(golf.topics[0]!.pages[0]!.body);
    // 14 concepts, 4 checks, 4 topic compositions and the root.
    expect(folded.items).toHaveLength(23);
    expect(folded.items[folded.items.length - 1]).toBe(folded.root);
    expect(folded.left).toEqual([]);
  });

  it('grades each check as the package says is right, and the same package folds to the same IRIs', () => {
    const check = byId.get(folded.topics[0]!.check!) as Fragment;
    expect(check).toMatchObject({ kind: 'assessment-item', title: 'Etiquette', body: '## Etiquette' });
    const asked = check.questions ?? [];
    expect(asked).toHaveLength(3);
    expect(questionIsRight('C', asked[0]!)).toBe(true);
    expect(questionIsRight('A', asked[0]!)).toBe(false);
    expect(questionIsRight('true', asked[1]!)).toBe(true);
    const handicapping = (byId.get(folded.topics[1]!.check!) as Fragment).questions ?? [];
    expect(questionIsRight('1', handicapping[1]!)).toBe(true);
    expect(questionIsRight('2', handicapping[1]!)).toBe(false);
    expect(foldPackage(golf, { competency: 'golf-basics', blindFor }).root['@id']).toBe(folded.root['@id']);
  });

  it('names a topic\'s own competency where one is given for it, and the package\'s elsewhere', () => {
    const own = foldPackage(golf, { competency: 'golf-basics', topicCompetencies: { Handicapping: 'golf-handicaps' }, blindFor });
    expect(own.topics.map(t => t.competency.split('/').pop())).toEqual(['golf-basics', 'golf-handicaps', 'golf-basics', 'golf-basics']);
  });

  it('puts a topic of one part at its position itself, and says what did not fold', () => {
    const pkg: ImportedPackage = {
      title: 'Small',
      topics: [
        { id: 'one', title: 'One', pages: [{ path: 'one/a.html', title: 'A', body: 'Text.' }], questions: [] },
        { id: 'long', title: 'Long', pages: [{ path: 'long/a.html', title: 'Too long', body: 'x'.repeat(FRAGMENT_LIMITS.body + 1) }], questions: [] },
        { id: 'many', title: 'Many', pages: [], questions: Array.from({ length: FRAGMENT_LIMITS.questions + 2 }, (_, i) => ({ question: `Is ${i} even?`, type: 'true-false' as const, answer: i % 2 === 0 })) },
      ],
      unread: [],
    };
    const small = foldPackage(pkg, { competency: 'small' });
    expect(small.topics[0]!.at).toBe(small.topics[0]!.pages[0]!.concept);
    expect(small.topics[1]!.at).toBeUndefined();
    expect(small.topics[2]!.questions).toBe(FRAGMENT_LIMITS.questions);
    expect(small.left).toEqual([
      { path: 'long/a.html', why: `longer than a fragment holds: ${FRAGMENT_LIMITS.body + 1} characters of text, at most ${FRAGMENT_LIMITS.body}` },
      { path: 'many', why: `a check holds at most ${FRAGMENT_LIMITS.questions} questions; the other 2 were not folded` },
    ]);
    expect(small.root.positions).toHaveLength(2);
  });

  it('refuses what lies in the package as a PackageError, and what the caller named as a ContentError', () => {
    const empty: ImportedPackage = { title: 'Empty', topics: [], unread: [] };
    expect(() => foldPackage(empty, { competency: 'x' })).toThrow(PackageError);
    // More fragments than one fold makes, though no topic has more parts than a composition holds.
    const perTopic = 90;
    const huge: ImportedPackage = {
      title: 'Huge', unread: [],
      topics: Array.from({ length: Math.ceil((PACKAGE_FOLD_LIMITS.fragments + 1) / perTopic) }, (_, t) => ({
        id: `t${t}`, title: `T${t}`, questions: [], pages: Array.from({ length: perTopic }, (_, i) => ({ path: `t${t}/${i}.html`, title: `${i}`, body: `Page ${t}.${i}.` })),
      })),
    };
    expect(() => foldPackage(huge, { competency: 'x' })).toThrow(new PackageError(`the package has ${huge.topics.length * perTopic} pages and checks to fold; one fold makes at most ${PACKAGE_FOLD_LIMITS.fragments} fragments`));
    const crowded: ImportedPackage = {
      title: 'Crowded', unread: [],
      topics: [{ id: 't', title: 'T', questions: [], pages: Array.from({ length: 101 }, (_, i) => ({ path: `t/${i}.html`, title: `${i}`, body: `Page ${i}.` })) }],
    };
    expect(() => foldPackage(crowded, { competency: 'x' })).toThrow(new PackageError('topic t has 101 parts; a composition has at most 100'));
    let caught: unknown;
    try { foldPackage(golf, { competency: 'x', level: 'expert' as never }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ContentError);
    expect(caught).not.toBeInstanceOf(PackageError);
  });
});

describe('the fold route takes a hosted package', () => {
  const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf("app.post('/agent/content/fold-course'"), server.indexOf('// ── What has worked where'));
  const branch = route.slice(route.indexOf('if (p.package_sha256 !== undefined) {'), route.indexOf('const courseId = typeof p.course_id'));

  it('names a package hosted here by its sha-256, and reads it from where it is kept', () => {
    expect(branch).toContain('if (!PACKAGE_SHA.test(sha)) { res.status(400)');
    expect(branch).toContain('const zip = await hostedPackages.open(sha);');
    expect(branch).toContain('if (!zip) { res.status(404)');
    expect(branch).toContain("imported = readPackage(filesOfZip(zip), { fileUrl: path => `${packageIri}/files/${path.split('/').map(encodeURIComponent).join('/')}` });");
  });

  it('blinds the checks under the bridge\'s secret, keeps the bundle with what it was derived from, and tells a package\'s fault from the caller\'s', () => {
    expect(branch).toContain('blindFor: topicId => createHmac(\'sha256\', courseFoldSecret).update(`package-fold\\n${packageIri}\\n${topicId}`).digest(\'hex\'),');
    expect(branch).toContain('if (e instanceof PackageError) { res.status(422)');
    expect(branch).toContain('if (e instanceof ContentError) { res.status(400)');
    expect(branch).toContain('await keepContentBundle(foldedPackage.root, foldedPackage.items, auth.callerDid, p.subject_pod_url, packageIri);');
    expect(branch).toContain('unread: [...imported.unread, ...foldedPackage.left]');
    expect(server).toContain("content: { '@id': root['@id'], items, ...(derivedFrom ? { derivedFrom } : {}) }");
  });

  it('is offered as the fold affordance, for a package as for a course', async () => {
    const { foxxiAffordances } = await import('../affordances.js');
    const fold = foxxiAffordances.find(a => a.toolName === 'foxxi.content_fold_course')!;
    expect(fold.inputs.find(i => i.name === '_signed_payload')!.description).toContain('package_sha256, competency?, topic_competencies?');
    expect(Object.keys(fold.outputs?.properties ?? {})).toEqual(expect.arrayContaining(['package', 'topics', 'unread', 'derivedFrom', 'checks']));
  });
});

describe('the Author page folds a hosted package', () => {
  const COMPOSITION = `https://bridge.example/ns/foxxi/composition/${'c'.repeat(64)}`;

  it('reads the fold\'s answer: its composition, each topic\'s parts, and what was not read', () => {
    expect(foldedPackageFrom({
      '@id': COMPOSITION, composition: { title: 'Golf' }, items: 23, checks: 'Graded on this bridge.',
      topics: [{ title: 'Etiquette', at: COMPOSITION, pages: [{}, {}, {}], questions: 3 }, { title: 'Empty', pages: [], questions: 0 }, { pages: [] }, null],
      unread: [{ path: 'shared/launchpage.html', why: 'chrome' }, { path: 7 }, null],
    })).toEqual({
      iri: COMPOSITION, title: 'Golf', items: 23, checks: 'Graded on this bridge.',
      topics: [{ title: 'Etiquette', pages: 3, questions: 3, folded: true }, { title: 'Empty', pages: 0, questions: 0, folded: false }],
      unread: [{ path: 'shared/launchpage.html', why: 'chrome' }],
    });
    // An answer that names no composition is not a fold.
    for (const bad of [{ '@id': 'javascript:alert(1)' }, { '@id': COMPOSITION.replace('composition', 'fragment') }, {}, null]) expect(foldedPackageFrom(bad)).toBeNull();
  });

  it('lists what the entry point links, folds one signed as the author, and puts it on their shelf', () => {
    const card = readFileSync(new URL('../dashboard-app/src/components/FoldPackageCard.tsx', import.meta.url), 'utf8');
    expect(card).toContain("const listHref = linkOf(entry, 'scorm-packages');");
    expect(card).toContain("const fold = useAffordance('foxxi.content_fold_course');");
    expect(card).toContain('foldedPackageFrom(await postSigned(fold.href, signerFor(session), { package_sha256: p.packageSha256 }))');
    expect(card).toContain("onFolded({ iri: view.iri, type: 'composition', title: view.title, at: new Date().toISOString() });");
    expect(card).toContain('{f.view.unread.map((u, i) => <li key={i}><code>{u.path}</code>: {u.why}</li>)}');
    const panel = readFileSync(new URL('../dashboard-app/src/components/AuthorPanel.tsx', import.meta.url), 'utf8');
    expect(panel).toContain("{tab === 'fold' && <FoldPackageCard session={session} onFolded={put} />}");
  });
});
