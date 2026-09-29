/**
 * A package an authoring tool built, read in that tool's own content model rather than as the web
 * pages its runtime draws. Such a runtime draws every page from data it ships beside itself, so read
 * as HTML the package is mostly "no text of its own: what it shows, its script draws". The data is
 * the course: its structure, its text, its questions, and which answers are right.
 *
 * Two tools' models are read here, both open and documented, as a tool builds a course to be played
 * and as it exports one to be edited again:
 * - Adapt: course/<language>/*.json, whose items (the course, its menus and pages, articles, blocks
 *   and components) each say what they are (`_type`) and name their parent; under the folder a build
 *   is served from, or an export's src/;
 * - H5P: h5p.json, naming the main library, and content/content.json, its params, each nested piece
 *   a library with params of its own; an .h5p file, or H5P content a package plays.
 * Rise 360's model, which it keeps as JSON inside the page its runtime draws, is read by
 * rise-course.ts; Storyline's, which it keeps as JSON in the data files its player loads, by
 * storyline-course.ts; iSpring's, which it keeps as base64 in the player's page, by
 * ispring-course.ts; Captivate's, which it keeps as a JavaScript object literal beside its player,
 * by captivate-course.ts. Each becomes the model package-import.ts reads a package into, topics of
 * pages and questions, so it folds, resolves per learner, plays and learns as any hosted package
 * does. A package no tool here models is read as package-import.ts reads any package.
 *
 * ★ READ AS THE TOOL DECLARES IT, AND NOTHING INVENTED. An Adapt option is right when the tool marks
 * it to be selected; an H5P answer is right when it is marked correct, or, in the two types whose
 * format keeps the right statement first (a single-choice set, a summary), because it is first. What
 * a tool does not declare is left out and listed with why: media, an essay, an interaction graded
 * some way this bridge does not grade, a question or option that is a picture.
 *
 * ★ GRADED AS THE TOOL GRADES IT (Codex, on #573). A typed answer's letter case counts where the
 * tool counts it: an H5P blank unless its author said not (it does by default), an Adapt blank
 * unless its author allows any case, a flashcard only where its author said so. A blank that takes
 * misspellings is left out, since a check here would mark one wrong.
 *
 * ★ WHAT THE TOOL SHUFFLES IS TURNED. A check here shows a choice's options in the order kept. Where
 * the tool shows them shuffled (a right-first list, and options it randomizes), the order kept tells
 * too much: the right one is often first. So those options are turned by a count the question's own
 * text decides, the same way every time, so a package folds to the same IRIs. A pool of words to
 * drag is offered in alphabetical order, which says nothing of where each goes.
 *
 * ★ A BLANK AT A TIME. A sentence with several blanks is asked one blank at a time, the others elided
 * (…), since a question here asks one thing.
 *
 * ★ AN EXPORT THAT IS NO PACKAGE. An .h5p file, or an Adapt course exported as source, has no
 * manifest and nothing to launch as it is (`projectExportOf`). The upload takes it all the same, and
 * the bridge keeps it beside the packages it hosts, to be folded (scorm-hosting.ts).
 */
import AdmZip from 'adm-zip';
import { filesOfZip, packageLookup, readPackage, type ImportedPackage, type ImportedQuestion, type ImportedTopic, type PackageFiles } from './package-import.js';
import { plainText } from './question-banks.js';
import { risePackage } from './rise-course.js';
import { captivatePackage } from './captivate-course.js';
import { ispringPackage } from './ispring-course.js';
import { storylinePackage } from './storyline-course.js';
import {
  choice, esc, imgHtml, isRecord, joined, numberOf, Reading, records, SHOWS, str, turned, WITH_MEDIA,
  type Json, type ToolReadOptions,
} from './tool-reading.js';

export type { ToolReadOptions } from './tool-reading.js';

/** A picture as HTML: its file (the large one first) and its alt text. */
function imageHtml(g: unknown): string {
  if (!isRecord(g)) return '';
  return imgHtml(str(g.large) || str(g.src) || str(g.small) || str(g.path), str(g.alt));
}

// ── Adapt ───────────────────────────────────────────────────────────

/** What an item is, by the file an export keeps it in, when the item does not say (`_type`). */
const ADAPT_FILE_TYPES: Record<string, string> = {
  'course.json': 'course', 'contentobjects.json': 'page', 'articles.json': 'article', 'blocks.json': 'block', 'components.json': 'component',
};
const ADAPT_TYPES = new Set(['course', 'menu', 'page', 'article', 'block', 'component']);
const ADAPT_QUESTIONS = new Set(['mcq', 'gmcq', 'textinput', 'matching', 'slider']);
const ADAPT_ITEMS = new Set(['accordion', 'narrative', 'hotgraphic']);
/** A file of a language of an Adapt course: the folder course/ is in, the language, the file. */
const ADAPT_FILE = /^((?:[^/]+\/)*?)course\/([^/]+)\/([^/]+\.json)$/;

interface AdaptItem { item: Json; type: string; file: string }

/** A language's items, as its folder's JSON keeps them, in order. */
function adaptItems(r: Reading, files: readonly string[]): AdaptItem[] {
  const out: AdaptItem[] = [];
  for (const file of files) {
    const value = r.json(file);
    const fallback = ADAPT_FILE_TYPES[file.slice(file.lastIndexOf('/') + 1).toLowerCase()] ?? '';
    for (const item of Array.isArray(value) ? records(value) : isRecord(value) ? [value] : []) {
      const type = str(item._type) || fallback;
      if (ADAPT_TYPES.has(type) && (type === 'course' || str(item._id))) out.push({ item, type, file });
    }
  }
  return out;
}

/** An Adapt course is a page and a component at least. */
const isAdaptCourse = (items: readonly AdaptItem[]): boolean =>
  items.some(x => x.type === 'page') && items.some(x => x.type === 'component' && str(x.item._component));

function adaptQuestion(r: Reading, c: Json, kind: string, topic: ImportedTopic, where: string): void {
  const stem = plainText(str(c.body));
  if (stem === null) { r.left(where, `its question ${SHOWS}`); return; }
  const question = stem || (plainText(str(c.displayTitle)) ?? '');
  if (!question) { r.left(where, 'its question has no text'); return; }
  const items = records(c._items);
  if (kind === 'mcq' || kind === 'gmcq') {
    if (items.some(it => imageHtml(it._graphic))) { r.left(where, 'its options are pictures, which a check here would not show'); return; }
    const options = items.map(it => plainText(str(it.text)));
    if (options.some(o => o === null)) { r.left(where, `an option ${SHOWS}`); return; }
    const right = items.flatMap((it, i) => (it._shouldBeSelected === true ? [i] : []));
    if (!right.length) { r.left(where, 'it marks no option as one to select'); return; }
    const shown = c._isRandom === true ? turned(options as string[], right, question) : { options: options as string[], right };
    r.keep(topic, choice(question, shown.options, shown.right, numberOf(c._selectable) > 1), where);
    return;
  }
  if (kind === 'textinput') {
    if (c._allowAnyOrder === true) { r.left(where, 'its blanks may be filled in any order, and a question here fills one blank'); return; }
    // Letter case counts unless its author allows any case, as the tool grades it.
    const caseSensitive = c._allowsAnyCase !== true;
    items.forEach((it, i) => {
      const at = items.length > 1 ? `${where}/${i + 1}` : where;
      const answers = (Array.isArray(it._answers) ? it._answers : [])
        .map(a => (typeof a === 'number' ? String(a) : str(a).trim())).filter(Boolean);
      if (!answers.length) { r.left(at, 'its blank gives no answer'); return; }
      const prefix = plainText(str(it.prefix));
      const suffix = plainText(str(it.suffix));
      if (prefix === null || suffix === null) { r.left(at, `its blank ${SHOWS}`); return; }
      // "Bend your ____." : a suffix that starts with punctuation follows the blank as it would a word.
      const blank = `${prefix ? `${prefix} ` : ''}____${suffix ? (/^[.,;:!?)]/.test(suffix) ? suffix : ` ${suffix}`) : ''}`;
      r.keep(topic, {
        question: joined(question, blank), type: 'fill-in', answer: answers[0]!,
        ...(answers.length > 1 ? { accept: answers.slice(1) } : {}), ...(caseSensitive ? { caseSensitive: true as const } : {}),
        // Adapt compares the whole reply; where its author allows punctuation, without it.
        compare: c._allowsPunctuation === true ? 'letters' : 'exact',
      }, at);
    });
    return;
  }
  if (kind === 'matching') {
    const pairs: Array<[string, string]> = [];
    const targets: string[] = [];
    for (const it of items) {
      const options = records(it._options);
      const texts = options.map(o => plainText(str(o.text)));
      const prompt = plainText(str(it.text));
      if (prompt === null || texts.some(t => t === null)) { r.left(where, `an item or an option ${SHOWS}`); return; }
      const right = options.flatMap((o, k) => (o._isCorrect === true ? [texts[k]!] : []));
      if (right.length !== 1) { r.left(where, `an item has ${right.length} right options, and a match here has one`); return; }
      pairs.push([prompt, right[0]!]);
      for (const t of texts) if (t && !targets.includes(t)) targets.push(t);
    }
    const used = new Set(pairs.map(p => p[1]));
    const distractors = targets.filter(t => !used.has(t));
    r.keep(topic, { question, type: 'matching', pairs, ...(distractors.length ? { distractors } : {}) }, where);
    return;
  }
  // A slider: its right value, on its scale. A range made one value is that value; a wider one is not one answer.
  const start = numberOf(c._scaleStart);
  const end = numberOf(c._scaleEnd);
  const range = isRecord(c._correctRange) ? [numberOf(c._correctRange._bottom), numberOf(c._correctRange._top)] : [Number.NaN, Number.NaN];
  const onScale = (v: number): boolean => (!Number.isFinite(start) || v >= start) && (!Number.isFinite(end) || v <= end);
  let answer = numberOf(c._correctAnswer);
  if (!Number.isFinite(answer) && range[0] === range[1] && Number.isFinite(range[0]) && onScale(range[0]!)) answer = range[0]!;
  if (!Number.isFinite(answer)) { r.left(where, range[0]! < range[1]! ? 'it marks a range as right, not one value' : 'it marks no right value'); return; }
  if (!onScale(answer)) { r.left(where, 'its right value is off its own scale'); return; }
  r.keep(topic, { question, type: 'numeric', answer, ...(Number.isFinite(start) ? { min: start } : {}), ...(Number.isFinite(end) ? { max: end } : {}) }, where);
}

/** A component as the HTML it shows; a question is kept on its topic instead, and shows nothing here. */
function adaptComponent(r: Reading, x: AdaptItem, topic: ImportedTopic): string {
  const c = x.item;
  const kind = str(c._component).toLowerCase();
  const where = `${x.file}#${str(c._id)}`;
  if (ADAPT_QUESTIONS.has(kind)) { adaptQuestion(r, c, kind, topic, where); return ''; }
  const head = str(c.displayTitle).trim() ? `<h3>${str(c.displayTitle)}</h3>` : '';
  const body = str(c.body);
  if (kind === 'blank') return '';
  if (kind === 'text') return head + body;
  if (kind === 'graphic') return head + body + imageHtml(c._graphic);
  if (ADAPT_ITEMS.has(kind)) {
    const items = records(c._items).map(it => (str(it.title).trim() ? `<p><strong>${str(it.title)}</strong></p>` : '') + str(it.body) + imageHtml(it._graphic));
    return head + body + (kind === 'hotgraphic' ? imageHtml(c._graphic) : '') + items.join('');
  }
  const kept = head || body.trim() ? '; its title and body are kept' : '';
  r.left(where, kind === 'media' ? `a video or audio, which is not text${kept}` : `a ${kind || 'component'} component, whose interaction is not read${kept}`);
  return head + body;
}

/**
 * A package Adapt built or exported, read in Adapt's own model: each page a topic, each article a
 * page (its blocks under their titles, their components in order), and each question component a
 * question on its page's topic. What its author made unavailable is left out, as the course leaves
 * it out: the course in the folder `at`, else the package's shallowest. Null when there is no
 * Adapt course there.
 */
export function adaptPackage(files: PackageFiles, opts: ToolReadOptions, at?: string): ImportedPackage | null {
  const roots = new Map<string, Map<string, string[]>>();
  for (const name of files.names) {
    const m = ADAPT_FILE.exec(name);
    if (!m) continue;
    const languages = roots.get(m[1]!) ?? new Map<string, string[]>();
    roots.set(m[1]!, languages);
    languages.set(m[2]!, [...(languages.get(m[2]!) ?? []), name]);
  }
  const r = new Reading(files, opts.fileUrl);
  let found: { root: string; items: AdaptItem[] } | null = null;
  // The shallowest course first; in it, the language its config names, else English, else the first.
  for (const root of at !== undefined ? [at].filter(a => roots.has(a)) : [...roots.keys()].sort((a, b) => a.length - b.length)) {
    const languages = roots.get(root)!;
    const config = r.json(`${root}course/config.json`);
    const preferred = isRecord(config) ? str(config._defaultLanguage) : '';
    const order = [...new Set([preferred, 'en', ...[...languages.keys()].sort()])].filter(l => languages.has(l));
    for (const language of order) {
      const items = adaptItems(r, languages.get(language)!);
      if (isAdaptCourse(items)) { found = { root, items }; break; }
    }
    if (found) break;
  }
  if (!found) return null;
  const { root, items } = found;

  const children = new Map<string, AdaptItem[]>();
  for (const x of items) {
    const parent = str(x.item._parentId);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), x]);
  }
  const childrenOf = (id: string, types: readonly string[]): AdaptItem[] => (children.get(id) ?? []).filter(x => types.includes(x.type));
  /** Whether the course shows an item; one its author made unavailable is listed, where it is met. */
  const available = (x: AdaptItem): boolean => {
    if (x.item._isAvailable !== false) return true;
    r.left(`${x.file}#${str(x.item._id)}`, 'its author made it unavailable, so the course does not show it');
    return false;
  };
  const course = items.find(x => x.type === 'course');
  const courseId = course ? str(course.item._id) || 'course' : 'course';

  // Pages in the course's order, a menu's pages where the menu is. A page whose parent is no item
  // (its menu was not exported) comes after them.
  const pages: AdaptItem[] = [];
  const walk = (parent: string, depth: number): void => {
    for (const x of childrenOf(parent, ['menu', 'page'])) {
      if (!available(x)) continue;
      if (x.type === 'page') pages.push(x);
      else if (depth < 20) walk(str(x.item._id), depth + 1);
    }
  };
  walk(courseId, 0);
  const ids = new Set(items.map(x => str(x.item._id)));
  for (const x of items) {
    if (x.type === 'page' && !pages.includes(x) && !ids.has(str(x.item._parentId)) && x.item._isAvailable !== false) pages.push(x);
  }

  const topics: ImportedTopic[] = [];
  for (const page of pages) {
    const id = str(page.item._id);
    const titleHtml = str(page.item.displayTitle) || str(page.item.title) || esc(id);
    const topic: ImportedTopic = { id, title: plainText(titleHtml) || id, pages: [], questions: [] };
    if (str(page.item.body).trim()) {
      const intro = r.page(titleHtml, str(page.item.body), root);
      if (intro.body.trim()) topic.pages.push({ path: `${page.file}#${id}`, title: intro.title || topic.title, body: intro.body });
    }
    for (const article of childrenOf(id, ['article'])) {
      if (!available(article)) continue;
      let html = str(article.item.body);
      for (const block of childrenOf(str(article.item._id), ['block'])) {
        if (!available(block)) continue;
        const parts = childrenOf(str(block.item._id), ['component']).map(x => (available(x) ? adaptComponent(r, x, topic) : '')).join('');
        const blockBody = str(block.item.body);
        if (!parts.trim() && !blockBody.trim()) continue;
        html += (str(block.item.displayTitle).trim() ? `<h2>${str(block.item.displayTitle)}</h2>` : '') + blockBody + parts;
      }
      if (!html.trim()) continue;
      const read = r.page(str(article.item.displayTitle).trim() ? str(article.item.displayTitle) : titleHtml, html, root);
      if (read.body.trim()) topic.pages.push({ path: `${article.file}#${str(article.item._id)}`, title: read.title || topic.title, body: read.body });
    }
    if (topic.pages.length || topic.questions.length) topics.push(topic);
  }
  const title = (course ? plainText(str(course.item.displayTitle) || str(course.item.title)) : '') || opts.title?.trim() || 'Imported course';
  return { title, topics, unread: r.unread };
}

// ── H5P ─────────────────────────────────────────────────────────────

/** "H5P.MultiChoice 1.16" is H5P.MultiChoice. */
const machineOf = (library: string): string => library.trim().split(/\s+/)[0] ?? '';
/** Whether a question comes with a picture or a video of its own (its `media`). */
const hasMedia = (p: Json): boolean => isRecord(p.media) && isRecord(p.media.type) && !!str(p.media.type.library);
/**
 * "*answer/other:tip*": the answers, split at "/", a tip after ":" not one of them. "\/" and "\:"
 * are those characters in an answer, as H5P escapes them (Codex, on #573).
 */
const blankAnswers = (inner: string): string[] => inner.split(/(?<!\\):/)[0]!.split(/(?<!\\)\//)
  .map(a => plainText(a.replace(/\\([/:])/g, '$1'))?.trim() ?? '').filter(Boolean);
/** Presentational pieces, which say nothing to read. */
const DECORATION = new Set(['H5P.Shape', 'H5P.Line']);
/** A presentation longer than a topic holds becomes topics of this many slides each. */
const SLIDES_PER_TOPIC = 50;

/** A sentence with its k-th blank asked (____) and its others elided (…). */
function elided(sentence: string, blanks: RegExpMatchArray[], k: number): string {
  let out = '';
  let last = 0;
  blanks.forEach((b, j) => {
    out += sentence.slice(last, b.index!) + (j === k ? '____' : '…');
    last = b.index! + b[0].length;
  });
  return out + sentence.slice(last);
}

class H5pReading {
  readonly topics: ImportedTopic[] = [];
  private topic: ImportedTopic | null = null;
  private html = '';
  private pageAt = '';

  constructor(private readonly r: Reading, private readonly folder: string, private readonly file: string) {}

  open(id: string, title: string): void {
    this.flush();
    this.topic = { id, title, pages: [], questions: [] };
    this.topics.push(this.topic);
  }

  /** The page being written ends here, titled as given (text) or as its topic. */
  flush(title?: string): void {
    if (this.topic && this.html.trim()) {
      const read = this.r.page(esc(title || this.topic.title), this.html, this.folder);
      if (read.body.trim()) this.topic.pages.push({ path: this.pageAt, title: read.title || this.topic.title, body: read.body });
    }
    this.html = '';
    this.pageAt = '';
  }

  private show(html: string, where: string): void {
    if (!html.trim()) return;
    if (!this.html) this.pageAt = `${this.file}#${where}`;
    this.html += html;
  }

  private left(where: string, why: string): void {
    this.r.left(`${this.file}#${where}`, why);
  }

  private ask(q: ImportedQuestion | string, where: string): void {
    if (this.topic) this.r.keep(this.topic, q, `${this.file}#${where}`);
  }

  /** One piece of content, by its library, at `where` in content.json. */
  piece(library: string, params: unknown, where: string, depth = 0): void {
    const p = isRecord(params) ? params : {};
    const kind = machineOf(library);
    if (depth > 12) { this.left(where, 'nested deeper than is read'); return; }
    switch (kind) {
      case 'H5P.Column':
        records(p.content).forEach((c, i) => { const inner = isRecord(c.content) ? c.content : {}; this.piece(str(inner.library), inner.params, `${where}/content/${i}`, depth + 1); });
        return;
      case 'H5P.QuestionSet':
        this.show(isRecord(p.introPage) ? str(p.introPage.introduction) : '', `${where}/introPage`);
        records(p.questions).forEach((q, i) => this.piece(str(q.library), q.params, `${where}/questions/${i}`, depth + 1));
        return;
      case 'H5P.Accordion':
        records(p.panels).forEach((panel, i) => {
          const inner = isRecord(panel.content) ? panel.content : {};
          const before = this.html.length;
          this.piece(str(inner.library), inner.params, `${where}/panels/${i}/content`, depth + 1);
          // A panel's title heads what it shows; a panel that shows nothing here has no heading.
          if (this.html.length > before && str(panel.title).trim()) this.html = `${this.html.slice(0, before)}<h3>${esc(str(panel.title))}</h3>${this.html.slice(before)}`;
        });
        return;
      case 'H5P.AdvancedText':
      case 'H5P.Text':
      case 'H5P.ContinuousText':
        this.show(str(p.text), where);
        return;
      case 'H5P.Table':
        // A table keeps its HTML in its own field (Codex, on #573).
        this.show(str(p.table) || str(p.text), where);
        return;
      case 'H5P.Image': {
        const src = isRecord(p.file) ? str(p.file.path) : '';
        if (!src.trim() || !this.r.finds(src, this.folder)) { this.left(where, 'an image whose file is not in the package'); return; }
        this.show(`<p><img src="${esc(src)}" alt="${esc(str(p.alt))}"></p>`, where);
        return;
      }
      case 'H5P.Link': {
        const w = isRecord(p.linkWidget) ? p.linkWidget : {};
        const url = `${str(w.protocol)}${str(w.url)}`;
        this.show(`<p><a href="${esc(url)}">${esc(str(p.title) || url)}</a></p>`, where);
        return;
      }
      case 'H5P.Dialogcards':
        this.show(str(p.description), where);
        records(p.dialogs).forEach((d, i) => this.show(`<p><strong>${str(d.text)}</strong></p>${str(d.answer)}${imageHtml(d.image)}`, `${where}/dialogs/${i}`));
        return;
      case 'H5P.MultiChoice': {
        if (hasMedia(p)) { this.ask(WITH_MEDIA, where); return; }
        const question = plainText(str(p.question));
        const answers = records(p.answers);
        const options = answers.map(a => plainText(str(a.text)));
        if (question === null || options.some(o => o === null)) { this.ask(`its question or an option ${SHOWS}`, where); return; }
        const right = answers.flatMap((a, i) => (a.correct === true ? [i] : []));
        if (!right.length) { this.ask('it marks no answer correct', where); return; }
        const behaviour = isRecord(p.behaviour) ? p.behaviour : {};
        // The tool shuffles the answers unless its author said not to.
        const shown = behaviour.randomAnswers === false ? { options: options as string[], right } : turned(options as string[], right, question);
        this.ask(choice(question, shown.options, shown.right, behaviour.type === 'multi'), where);
        return;
      }
      case 'H5P.TrueFalse': {
        if (hasMedia(p)) { this.ask(WITH_MEDIA, where); return; }
        const question = plainText(str(p.question));
        const said = str(p.correct).trim().toLowerCase();
        if (question === null) this.ask(`its question ${SHOWS}`, where);
        else this.ask(said === 'true' || said === 'false' ? { question, type: 'true-false', answer: said === 'true' } : 'it marks neither true nor false correct', where);
        return;
      }
      case 'H5P.Blanks': {
        if (hasMedia(p)) { this.ask(WITH_MEDIA, where); return; }
        // Graded as the tool grades it (Codex, on #573): letter case counts unless its author said
        // not (it does by default), and a blank that accepts misspellings is one a check here would not grade so.
        const behaviour = isRecord(p.behaviour) ? p.behaviour : {};
        if (behaviour.acceptSpellingErrors === true) { this.ask('it accepts misspelled answers, which a check here would mark wrong', where); return; }
        const caseSensitive = behaviour.caseSensitive !== false;
        const lead = plainText(str(p.text)) ?? '';
        (Array.isArray(p.questions) ? p.questions : []).forEach((raw, i) => {
          const sentence = str(raw);
          const blanks = [...sentence.matchAll(/\*([^*]+)\*/g)];
          const at = `${where}/questions/${i}`;
          if (!blanks.length) { this.ask('it has no blank', at); return; }
          blanks.forEach((b, k) => {
            const answers = blankAnswers(b[1]!);
            const asked = blanks.length > 1 ? `${at}/${k + 1}` : at;
            const shown = plainText(elided(sentence, blanks, k));
            if (shown === null) { this.ask(`its sentence ${SHOWS}`, asked); return; }
            this.ask(answers.length
              ? {
                question: joined(lead, shown), type: 'fill-in', answer: answers[0]!,
                ...(answers.length > 1 ? { accept: answers.slice(1) } : {}), ...(caseSensitive ? { caseSensitive: true as const } : {}),
                compare: 'exact',
              }
              : 'its blank gives no answer', asked);
          });
        });
        return;
      }
      case 'H5P.DragText': {
        // Each gap takes one word of a pool: every gap's word, and the distractors.
        const text = str(p.textField);
        const pool = [...text.matchAll(/\*([^*]+)\*/g), ...str(p.distractors).matchAll(/\*([^*]+)\*/g)]
          .map(m => blankAnswers(m[1]!)[0] ?? '').filter(Boolean);
        const options = [...new Set(pool)].sort((a, b) => a.localeCompare(b));
        const lead = plainText(str(p.taskDescription)) ?? '';
        let n = 0;
        for (const line of text.split(/\r?\n/)) {
          const gaps = [...line.matchAll(/\*([^*]+)\*/g)];
          gaps.forEach((g, k) => {
            const at = `${where}/gaps/${++n}`;
            const word = blankAnswers(g[1]!)[0];
            const shown = plainText(elided(line, gaps, k));
            if (!word) { this.ask('its gap gives no word', at); return; }
            if (shown === null) { this.ask(`its text ${SHOWS}`, at); return; }
            this.ask(choice(joined(lead, shown), options, [options.indexOf(word)], false), at);
          });
        }
        if (!n) this.ask('it has no gap', where);
        return;
      }
      case 'H5P.SingleChoiceSet':
        records(p.choices).forEach((c, i) => {
          const at = `${where}/choices/${i}`;
          const question = plainText(str(c.question));
          const options = (Array.isArray(c.answers) ? c.answers : []).map(a => plainText(str(a)));
          if (question === null || options.some(o => o === null)) { this.ask(`its question or an option ${SHOWS}`, at); return; }
          // The first alternative is the right one, and the tool shuffles them.
          const shown = turned(options as string[], [0], question);
          this.ask(choice(question, shown.options, shown.right, false), at);
        });
        return;
      case 'H5P.Summary': {
        // Its own words when an author gave none: the type shows this line.
        const intro = plainText(str(p.intro)) || 'Choose the correct statement.';
        records(p.summaries).forEach((s, i) => {
          const at = `${where}/summaries/${i}`;
          const options = (Array.isArray(s.summary) ? s.summary : []).map(a => plainText(str(a)));
          if (options.some(o => o === null)) { this.ask(`a statement ${SHOWS}`, at); return; }
          // The first statement is the right one, and the tool shuffles them.
          const shown = turned(options as string[], [0], `${intro}\n${options.join('\n')}`);
          this.ask(choice(intro, shown.options, shown.right, false), at);
        });
        return;
      }
      case 'H5P.Flashcards': {
        this.show(str(p.description), where);
        // Letter case counts only where its author said so.
        const caseSensitive = p.caseSensitive === true || (isRecord(p.behaviour) && p.behaviour.caseSensitive === true);
        records(p.cards).forEach((c, i) => {
          const at = `${where}/cards/${i}`;
          const question = plainText(str(c.text));
          const answer = plainText(str(c.answer))?.trim() ?? '';
          if (imageHtml(c.image) || question === null) this.ask(WITH_MEDIA, at);
          else this.ask(answer ? { question, type: 'fill-in', answer, ...(caseSensitive ? { caseSensitive: true as const } : {}), compare: 'exact' } : 'its card gives no answer', at);
        });
        return;
      }
      case 'H5P.Video':
      case 'H5P.Audio':
      case 'H5P.InteractiveVideo':
        this.left(where, `${kind}: media, which is not text`);
        return;
      case 'H5P.Essay':
        this.left(where, `${kind}: an answer recorded rather than graded, left for a reflection written here`);
        return;
      default:
        if (!DECORATION.has(kind)) this.left(where, `${kind || 'a piece with no library'} is not read`);
    }
  }
}

/**
 * A package H5P built or exported (an .h5p file, or H5P content a package plays), read in H5P's own
 * model: an interactive book's chapters as topics, a presentation's slides as pages, and a
 * column's, a question set's or an accordion's pieces in order, text and images as pages and
 * questions on their topic: the content whose h5p.json is `at`, else the package's shallowest.
 * Null when there is no H5P content there.
 */
export function h5pPackage(files: PackageFiles, opts: ToolReadOptions, at?: string): ImportedPackage | null {
  const h5pJson = at ?? files.names.filter(n => /(^|\/)h5p\.json$/.test(n)).sort((a, b) => a.length - b.length)[0];
  if (!h5pJson) return null;
  const r = new Reading(files, opts.fileUrl);
  const base = h5pJson.slice(0, -'h5p.json'.length);
  const contentJson = `${base}content/content.json`;
  const meta = r.json(h5pJson);
  const params = r.json(contentJson);
  if (!isRecord(meta) || !isRecord(params)) return null;
  const title = plainText(esc(str(meta.title))) || opts.title?.trim() || 'Imported H5P content';
  const main = str(meta.mainLibrary);
  const reading = new H5pReading(r, `${base}content/`, contentJson);
  if (machineOf(main) === 'H5P.InteractiveBook') {
    records(params.chapters).forEach((chapter, i) => {
      const chapterTitle = isRecord(chapter.metadata) ? str(chapter.metadata.title).trim() : '';
      reading.open(`chapter-${i + 1}`, chapterTitle || `Chapter ${i + 1}`);
      reading.piece(str(chapter.library), chapter.params, `chapters/${i}`);
      reading.flush();
    });
  } else if (machineOf(main) === 'H5P.CoursePresentation') {
    const slides = isRecord(params.presentation) ? records(params.presentation.slides) : [];
    const chunked = slides.length > SLIDES_PER_TOPIC * 2 - 1;
    slides.forEach((slide, i) => {
      if (i === 0 || (chunked && i % SLIDES_PER_TOPIC === 0)) {
        const last = Math.min(slides.length, i + SLIDES_PER_TOPIC);
        if (chunked) reading.open(`slides-${i + 1}-${last}`, `${title}: slides ${i + 1} to ${last}`);
        else reading.open('presentation', title);
      }
      records(slide.elements).forEach((el, j) => {
        // An element with no action is a way to another slide, which shows nothing.
        if (isRecord(el.action)) reading.piece(str(el.action.library), el.action.params, `presentation/slides/${i}/elements/${j}`);
      });
      const keyword = records(slide.keywords).map(k => str(k.main).trim()).find(Boolean);
      reading.flush(keyword || `Slide ${i + 1}`);
    });
  } else {
    reading.open('content', title);
    reading.piece(main, params, 'content');
    reading.flush();
  }
  reading.flush();
  const topics = reading.topics.filter(t => t.pages.length || t.questions.length);
  return { title, topics, unread: r.unread };
}

/** The tools whose own exports are read here. */
export type ExportTool = 'Adapt' | 'H5P' | 'Rise 360' | 'Storyline' | 'iSpring' | 'Captivate';

/** An authoring tool's own export: the tool, its title, and what it reads as. */
export interface ProjectExport { tool: ExportTool; title: string; read: ImportedPackage }

/**
 * Where each tool read here starts a course, in the order the tools are tried in one folder: the
 * file its reader starts from, the course's folder before it. Adapt's course is its folder, the one
 * its course/<language>/ files are in.
 */
const COURSE_STARTS: ReadonlyArray<{ tool: ExportTool; start: RegExp; read: (files: PackageFiles, opts: ToolReadOptions, at: string) => ImportedPackage | null }> = [
  { tool: 'Adapt', start: ADAPT_FILE, read: adaptPackage },
  { tool: 'H5P', start: /^(.*\/)?h5p\.json$/, read: h5pPackage },
  { tool: 'Rise 360', start: /^(.*\/)?index\.html$/i, read: risePackage },
  { tool: 'Storyline', start: /^(.*\/)?html5\/data\/js\/data\.js$/, read: storylinePackage },
  { tool: 'iSpring', start: /^(.*\/)?(?:index|html5)\.html?$/i, read: ispringPackage },
  { tool: 'Captivate', start: /^(.*\/)?assets\/js\/(?:CPM|project)\.js$/, read: captivatePackage },
];

/** A course a package holds, read in its tool's own model, and the folder it is in ('' at the package's root). */
interface ToolCourse { tool: ExportTool; root: string; read: ImportedPackage }

/**
 * Every course a package holds, each read in its tool's own model. Folders are tried shallowest
 * first, the tools in order in each. A course in another's folder is part of that one: a Rise
 * course holds a Storyline block, a package of its own, inside it (a review of #579: the shallowest
 * course alone used to be read, and whatever else the package held was lost, unlisted).
 */
function toolCourses(files: PackageFiles, opts: ToolReadOptions): ToolCourse[] {
  const starts = new Map<string, { at: string; root: string; order: number }>();
  COURSE_STARTS.forEach(({ tool, start }, order) => {
    for (const name of files.names) {
      const m = start.exec(name);
      if (!m) continue;
      const root = m[1] ?? '';
      const at = tool === 'Adapt' ? root : name;
      starts.set(`${order}:${at}`, { at, root, order });
    }
  });
  const found: ToolCourse[] = [];
  for (const s of [...starts.values()].sort((a, b) => a.root.length - b.root.length || a.order - b.order || a.at.length - b.at.length)) {
    if (found.some(c => s.root.startsWith(c.root))) continue;
    const { tool, read } = COURSE_STARTS[s.order]!;
    const course = read(files, opts, s.at);
    if (course) found.push({ tool, root: s.root, read: course });
  }
  // In the order their folders are listed, a number in a name read as one ("module-2" before "module-10").
  return found.sort((a, b) => a.root.localeCompare(b.root, 'en', { numeric: true }));
}

/** A package's files less those in the given folders. */
function without(files: PackageFiles, folders: readonly string[]): PackageFiles {
  const kept = (name: string): boolean => !folders.some(f => name.startsWith(f));
  return { names: files.names.filter(kept), read: name => (kept(name) ? files.read(name) : null) };
}

/**
 * Several courses, and what the package holds beside them, as one package: what is beside them
 * first (a SCORM package's other activities, in its order), then each course's topics, titled by
 * their course where they are not already, their ids under its folder.
 */
function together(courses: readonly ToolCourse[], beside: ImportedPackage | null, opts: ToolReadOptions): ImportedPackage {
  const topics: ImportedTopic[] = [...(beside?.topics ?? [])];
  const unread = [...(beside?.unread ?? [])];
  for (const { root, read } of courses) {
    for (const t of read.topics) {
      const title = t.title === read.title || t.title.startsWith(`${read.title}: `) ? t.title : `${read.title}: ${t.title}`;
      topics.push({ ...t, id: `${root}${t.id}`, title });
    }
    unread.push(...read.unread);
  }
  return { title: beside?.title || opts.title?.trim() || courses[0]!.read.title, topics, unread };
}

/**
 * Any hosted package, read in the richest model it carries. Each course an authoring tool keeps in
 * it (Adapt, H5P, Rise 360, Storyline, iSpring, Captivate) is read in that tool's own model. What a
 * SCORM package holds beside its courses (its other activities) is read as package-import.ts reads
 * any package, its pages and the question banks it declares; a page that only launches a course has
 * no content of its own, and adds nothing. A course at the package's root, or in a folder that holds
 * the manifest, is the package. A package that holds no tool's course is read as any package is.
 */
export function readAnyPackage(files: PackageFiles, opts: ToolReadOptions): ImportedPackage {
  const courses = toolCourses(files, opts);
  if (!courses.length) return readPackage(files, opts);
  const manifest = packageLookup(files.names).entryFor('imsmanifest.xml');
  const rest = manifest && !courses.some(c => manifest.startsWith(c.root)) ? readPackage(without(files, courses.map(c => c.root)), opts) : null;
  const beside = rest?.topics.length ? rest : null;
  return courses.length === 1 && !beside ? courses[0]!.read : together(courses, beside, opts);
}

/**
 * An authoring tool's own export that is no SCORM package: an .h5p file, an Adapt course exported as
 * source, or a course Rise 360, Storyline, iSpring or Captivate published for xAPI or the web, or
 * several such courses in one zip, each read in its tool's model (the export is named for the
 * first). It has no manifest and launches nothing as it is, so it is kept to be folded. Null for a
 * SCORM or cmi5 package, which is hosted and played as one (even one a tool built), and for a zip
 * no tool here made. `title` is the one to use when the export names none. Throws when the bytes
 * are no zip.
 */
export function projectExportOf(zip: Buffer, title?: string): ProjectExport | null {
  const files = filesOfZip(new AdmZip(zip));
  const { entryFor } = packageLookup(files.names);
  if (entryFor('imsmanifest.xml') || entryFor('cmi5.xml')) return null;
  const opts: ToolReadOptions = { fileUrl: path => path, ...(title?.trim() ? { title } : {}) };
  const courses = toolCourses(files, opts);
  if (!courses.length) return null;
  const read = courses.length === 1 ? courses[0]!.read : together(courses, null, opts);
  return { tool: courses[0]!.tool, title: read.title, read };
}
