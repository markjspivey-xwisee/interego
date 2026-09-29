/**
 * A package iSpring published (iSpring Suite, Presenter, Converter or Free, 8 to 11): a presentation,
 * or a quiz iSpring QuizMaker made, for SCORM, xAPI or the web, read in iSpring's own model rather
 * than as the player page its runtime draws. The page carries the course as a base64 string, found
 * and decoded here without running anything:
 * - a presentation's `presInfo` (zlib-deflated JSON): its slides in playing order (`s`), each with
 *   its level in the outline (`l`), its text (`x`, shape by shape) and its notes (`N`, `n`); a quiz
 *   (`st: "q"`, in data/quizN.js) or an interaction (`st: "i"`, in data/intrN.js) in a slide's place;
 *   and each slide's own file (data/slideN.js), whose content layer holds its pictures;
 * - a quiz's `data` (QuizMaker 9.7 and later, JSON) or `quizJson` (QuizMaker 8, zlib-deflated): its
 *   question groups, and each question's type, text, answers and which are right.
 *
 * ★ READ AS ISPRING HOLDS IT. A presentation whose outline nests its slides is a topic per top-level
 * slide; one that does not is one topic (topics of fifty slides, one too long for a composition).
 * Each slide is a page: its text shape by shape, its pictures (not its background, nor text drawn
 * as a picture, whose text the slide keeps), and its notes. An interaction's items (tabs, an
 * accordion, a glossary, steps) are a page. A quiz is a topic of its questions, and its info slides
 * pages; a quiz in a presentation's slide is read into that slide's topic.
 *
 * ★ RIGHT AS ISPRING GRADES IT. A choice is right when iSpring marks it correct; a typed answer
 * accepts each answer it lists, letter case counted where the quiz says so; a sentence of blanks or
 * of lists is asked a blank at a time (tool-exports.ts); a match pairs what it pairs; an order is the
 * order the quiz keeps. A group the quiz draws from at random is asked whole. A survey, an essay, a
 * hotspot, a drag onto a picture, and a question that comes with a picture or media are left out,
 * with why. Options the player shuffles are turned (tool-reading.ts).
 */
import { inflateSync } from 'node:zlib';
import type { ImportedPackage, ImportedTopic, PackageFiles } from './package-import.js';
import { plainText } from './question-banks.js';
import {
  choice, esc, imgHtml, isRecord, jsStringAt, numberOf, Reading, records, str, turned, WITH_MEDIA,
  type Json, type ToolReadOptions,
} from './tool-reading.js';

/** The comment every page iSpring publishes opens with. */
const MARK = /<!--\s*Created with iSpring\s*-->/;
/** A presentation too long for one composition becomes topics of this many slides each. */
const SLIDES_PER_TOPIC = 50;
/** The most a decoded course may inflate to: a package is data, not a bomb. */
const MAX_INFLATED = 64 * 1024 * 1024;
/** A variable the player fills in (`%USER_NAME%`): its value is a running course's. */
const VARIABLE = /%[A-Za-z_][\w]*%/g;
/** Text that is only a number or a count ("5/5", "01"): a counter, not the slide's text. */
const COUNTER = /^[\d\s./()-]+$/;
const FILE_NAME = /\.(?:png|jpe?g|gif|svg|webp|bmp|emf|wmf)$/i;

/** The JSON a page assigns to `name` as a base64 string, zlib-deflated or not. */
export function assigned(text: string | null, name: string): Json | null {
  if (!text) return null;
  const m = new RegExp(`\\b${name}\\s*=\\s*"([A-Za-z0-9+/=]+)"`).exec(text);
  if (!m) return null;
  try {
    const bytes = Buffer.from(m[1]!, 'base64');
    const json = bytes[0] === 0x7b ? bytes : inflateSync(bytes, { maxOutputLength: MAX_INFLATED });
    const v: unknown = JSON.parse(json.toString('utf8'));
    return isRecord(v) ? v : null;
  } catch { return null; }
}

/** Rich text as iSpring keeps it (`{ a: clean HTML, d: its text }`), as plain text; a variable as "…". */
function richText(v: unknown): string {
  if (typeof v === 'string') return shownText(plainText(esc(v)) ?? '');
  return isRecord(v) ? htmlText(str(v.a)) : '';
}

/** HTML as the plain text it shows, a variable as "…", without the zero-width spaces an editor leaves. */
function htmlText(html: string): string {
  return shownText(plainText(html) ?? '');
}

const ZERO_WIDTH = /[\u200b\ufeff]/g;
const shownText = (t: string): string => t.replace(VARIABLE, '…').replace(ZERO_WIDTH, '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');

/** Rich text as HTML to show: its clean HTML, a variable as "…". */
const richHtml = (v: unknown): string => (isRecord(v) ? str(v.a).replace(VARIABLE, '…') : '');

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim();
/** Whether no two texts read the same, as a question here compares them (case and spacing aside). */
const distinct = (xs: string[]): boolean => new Set(xs.map(x => x.toLowerCase().replace(/\s+/g, ' '))).size === xs.length;
const SAME = 'two of its choices read the same, so which is which is only where each is';

/** Where an embedded blank or list sits in a sentence: the text, its pieces in order. */
interface Sentence { pieces: Array<string | { id: string; data: Json; type: string }> }

/** A sentence of blanks or lists (`{ d: [text | { id }], r: [{ id, type, data }] }`), its pieces in order. */
function sentenceOf(rt: unknown): Sentence | null {
  if (!isRecord(rt)) return null;
  const embedded = new Map(records(rt.r).map(e => [str(e.id), e] as const));
  const pieces: Sentence['pieces'] = [];
  for (const d of Array.isArray(rt.d) ? rt.d : []) {
    if (typeof d === 'string') pieces.push(d.replace(VARIABLE, '…'));
    else if (isRecord(d)) {
      const e = embedded.get(str(d.id));
      if (e) pieces.push({ id: str(e.id), data: isRecord(e.data) ? e.data : {}, type: str(e.type) });
    }
  }
  return pieces.some(p => typeof p !== 'string') ? { pieces } : null;
}

/** A sentence with one of its blanks shown (____) and the others elided (…). */
function oneBlank(s: Sentence, at: number): string {
  const lines = shownText(s.pieces.map((p, i) => (typeof p === 'string' ? p : i === at ? '____' : '…')).join('')).replace(/ ([,.;:!?])/g, '$1').split('\n');
  // Its own line of a sentence of several, and the line before when the blank stands alone.
  const k = lines.findIndex(l => l.includes('____'));
  return k < 0 ? lines.join('\n') : lines.slice(lines[k] === '____' && k > 0 ? k - 1 : k, k + 1).join('\n');
}

/** A question as iSpring grades it (QuizMaker 9.7 and later), kept on its topic, or why not, listed. */
function quizQuestion(r: Reading, q: Json, topic: ImportedTopic, where: string): void {
  const tp = str(q.tp);
  const settings = isRecord(q.s) ? q.s : {};
  if (tp === 'Essay' || tp === 'LikertScale' || settings.ee === false) { r.left(where, 'a survey question, which grades nothing'); return; }
  if (tp === 'Hotspot') { r.left(where, 'a hotspot question, which a check here would not show'); return; }
  if (tp === 'DND') { r.left(where, 'a drag-and-drop onto the slide, which a check here would not show'); return; }
  const at = isRecord(q.at) ? q.at : {};
  if (at.i || at.a || at.v) { r.left(where, WITH_MEDIA); return; }
  const prompt = richText(q.D);
  const C = isRecord(q.C) ? q.C : {};
  const caseSensitive = settings.cs === true;
  switch (tp) {
    case 'MultipleChoice':
    case 'TrueFalse':
    case 'MultipleResponse': {
      const chs = records(C.chs);
      const options = chs.map(c => richText(c.t));
      if (!options.length || options.some(o => !o)) { r.left(where, 'a choice is a picture, which a check here would not show'); return; }
      if (!distinct(options)) { r.left(where, SAME); return; }
      const right = chs.flatMap((c, i) => (c.c === true ? [i] : []));
      if (!right.length) { r.left(where, 'it marks no answer correct'); return; }
      if (!prompt) { r.left(where, 'its question has no text'); return; }
      // The player shows the choices shuffled where the question says so (`sh`).
      const shown = settings.sh === true ? turned(options, right, prompt) : { options, right };
      r.keep(topic, choice(prompt, shown.options, shown.right, tp === 'MultipleResponse'), where);
      return;
    }
    case 'TypeIn': {
      const accepted = [...new Set(records(C.chs).map(c => richText(c.t)).filter(Boolean))];
      if (!accepted.length) { r.left(where, 'it gives no answer'); return; }
      if (!prompt) { r.left(where, 'its question has no text'); return; }
      const [first, ...rest] = accepted;
      r.keep(topic, { question: prompt, type: 'fill-in', answer: first!, ...(rest.length ? { accept: rest } : {}), ...(caseSensitive ? { caseSensitive: true as const } : {}), compare: 'exact' }, where);
      return;
    }
    case 'FillInTheBlank':
    case 'MultipleChoiceText':
    case 'WordBank': {
      const s = sentenceOf(C.rt);
      if (!s) { r.left(where, 'its blanks are not in its text'); return; }
      const words = tp === 'WordBank'
        ? [...new Set([...s.pieces.flatMap(p => (typeof p === 'string' ? [] : [str(p.data.v).trim()])), ...(Array.isArray(C.ew) ? C.ew : []).map(w => (isRecord(w) ? richText(w.t) : str(w)).trim())].filter(Boolean))].sort((a, b) => a.localeCompare(b))
        : [];
      s.pieces.forEach((p, i) => {
        if (typeof p === 'string') return;
        const blankWhere = `${where}/${p.id}`;
        const asked = [prompt, oneBlank(s, i)].filter(Boolean).join('\n\n');
        if (tp === 'FillInTheBlank') {
          const accepted = [...new Set((Array.isArray(p.data.v) ? p.data.v : [p.data.v]).map(v => str(v).trim()).filter(Boolean))];
          if (!accepted.length) { r.left(blankWhere, 'it gives no answer'); return; }
          const [first, ...rest] = accepted;
          r.keep(topic, { question: asked, type: 'fill-in', answer: first!, ...(rest.length ? { accept: rest } : {}), ...(caseSensitive ? { caseSensitive: true as const } : {}), compare: 'exact' }, blankWhere);
        } else if (tp === 'MultipleChoiceText') {
          const options = (Array.isArray(p.data.v) ? p.data.v : []).map(v => str(v).trim());
          const right = numberOf(p.data.i);
          if (options.length < 2 || options.some(o => !o) || !Number.isInteger(right) || !options[right]) { r.left(blankWhere, 'its list names no right option'); return; }
          const shown = settings.sh === true ? turned(options, [right], asked) : { options, right: [right] };
          r.keep(topic, choice(asked, shown.options, shown.right, false), blankWhere);
        } else {
          const word = str(p.data.v).trim();
          if (!word) { r.left(blankWhere, 'it gives no answer'); return; }
          r.keep(topic, choice(asked, words, [words.indexOf(word)], false), blankWhere);
        }
      });
      return;
    }
    case 'Matching': {
      const pairs = records(C.m).map(m => [richText(isRecord(m.p) ? m.p.t : undefined), richText(isRecord(m.r) ? m.r.t : undefined)] as [string, string]);
      if (!pairs.length || pairs.some(([p, a]) => !p || !a)) { r.left(where, 'a match is a picture, which a check here would not show'); return; }
      const extra = records(isRecord(C.d) ? C.d.chs : []).map(c => richText(c.t)).filter(Boolean);
      r.keep(topic, { question: prompt || 'Match each item.', type: 'matching', pairs, ...(extra.length ? { distractors: extra } : {}) }, where);
      return;
    }
    case 'Sequence': {
      const items = records(C.chs).map(c => richText(c.t));
      if (items.length < 2 || items.some(i => !i)) { r.left(where, 'an item is a picture, which a check here would not show'); return; }
      r.keep(topic, { question: prompt || 'Put these in order.', type: 'sequencing', items }, where);
      return;
    }
    case 'Numeric': {
      const values = records(C.na).map(a => (str(a.co) === 'equal' ? numberOf(a.op) : Number.NaN));
      if (!values.length || values.some(v => !Number.isFinite(v))) { r.left(where, 'its right answer is a range or a comparison, not a value'); return; }
      if (!prompt) { r.left(where, 'its question has no text'); return; }
      const [first, ...rest] = [...new Set(values)];
      r.keep(topic, { question: prompt, type: 'numeric', answer: first!, ...(rest.length ? { accept: rest } : {}) }, where);
      return;
    }
    default:
      r.left(where, `a ${tp || 'untyped'} question, which is not read`);
  }
}

/** A QuizMaker 8 question (`quizJson`), kept on its topic, or why not, listed. */
function quiz8Question(r: Reading, q: Json, topic: ImportedTopic, where: string): void {
  const t = str(q.t);
  const prompt = oneLine(htmlText(str(q.d)));
  const answers = records(q.a);
  switch (t) {
    case 'mc':
    case 'mr':
    case 'yn': {
      const options = answers.map(a => oneLine(htmlText(str(a.t))));
      if (!options.length || options.some(o => !o)) { r.left(where, 'a choice is a picture, which a check here would not show'); return; }
      if (!distinct(options)) { r.left(where, SAME); return; }
      const right = answers.flatMap((a, i) => (a.c === true ? [i] : []));
      if (!right.length) { r.left(where, 'it marks no answer correct'); return; }
      if (!prompt) { r.left(where, 'its question has no text'); return; }
      // QuizMaker 8 shuffles a question's answers unless it says not (`sh: false`): most keep the
      // right one first.
      const shown = q.sh === false ? { options, right } : turned(options, right, prompt);
      r.keep(topic, choice(prompt, shown.options, shown.right, t === 'mr'), where);
      return;
    }
    case 'm': {
      const premises = new Map(records(q.P).map(p => [str(p.i), oneLine(htmlText(str(p.t)))] as const));
      const responses = new Map(records(q.R).map(p => [str(p.i), oneLine(htmlText(str(p.t)))] as const));
      const pairs = records(q.M).map(m => [premises.get(str(m.p)) ?? '', responses.get(str(m.r)) ?? ''] as [string, string]);
      if (!pairs.length || pairs.some(([p, a]) => !p || !a)) { r.left(where, 'a match is a picture, which a check here would not show'); return; }
      r.keep(topic, { question: prompt || 'Match each item.', type: 'matching', pairs }, where);
      return;
    }
    case 'wb': {
      // Its sentence in fragments of HTML, a blank ({ p }) between them: each read as the text it shows.
      const pieces: Sentence['pieces'] = (Array.isArray(q.D) ? q.D : []).map((p, i) => (typeof p === 'string'
        ? ` ${oneLine(htmlText(p))} `
        : isRecord(p) ? { id: String(i), data: { v: oneLine(htmlText(str(p.p))) }, type: 'wb' } : ''));
      const s: Sentence = { pieces };
      const extra = (Array.isArray(q.e) ? q.e : []).map(w => oneLine(htmlText(isRecord(w) ? str(w.p) : str(w))));
      const words = [...new Set([...pieces.flatMap(p => (typeof p === 'string' ? [] : [str(p.data.v)])), ...extra].filter(Boolean))].sort((a, b) => a.localeCompare(b));
      pieces.forEach((p, i) => {
        if (typeof p === 'string') return;
        const asked = [prompt, oneBlank(s, i)].filter(Boolean).join('\n\n');
        r.keep(topic, choice(asked, words, [words.indexOf(str(p.data.v).trim())], false), `${where}/${i}`);
      });
      return;
    }
    default:
      r.left(where, t === 'e' ? 'a survey question, which grades nothing' : `a question of the kind "${t || 'untyped'}", which is not read`);
  }
}

/** A quiz's questions (QuizMaker 9.7 and later), each group in order; its info slides pages. */
function readQuiz(r: Reading, quiz: Json, topicFor: (group: Json, g: number) => ImportedTopic, where: string, page: (topic: ImportedTopic, title: string, html: string, at: string) => void): void {
  const d = isRecord(quiz.d) ? quiz.d : quiz;
  const sl = isRecord(d.sl) ? d.sl : {};
  records(sl.g).forEach((g, gi) => {
    const topic = topicFor(g, gi);
    records(g.S).forEach((q, qi) => {
      const at = `${where}/groups/${gi}/${qi}`;
      if (str(q.tp) === 'InfoSlide') {
        const title = oneLine(richText(q.D));
        const body = isRecord(q.C) ? richHtml(q.C.rt) : '';
        if (title || plainText(body)) page(topic, title, body, at);
        return;
      }
      quizQuestion(r, q, topic, at);
    });
  });
}

/** A slide's pictures, from its own file's content layer: not its background, nor text drawn as a picture. */
function slidePictures(r: Reading, root: string, file: string, text: string, size: { w: number; h: number }): string {
  const src = r.text(`${root}${file}`);
  if (!src) return '';
  const at = src.indexOf('loadHandler(');
  const quote = at < 0 ? -1 : src.indexOf("'", at);
  const html = quote < 0 ? '' : jsStringAt(src, quote)?.value ?? '';
  const content = html.slice(Math.max(0, html.search(/id="spr2_/)));
  const seen = new Set<string>();
  let out = '';
  for (const tag of content.match(/<img\b[^>]*>/g) ?? []) {
    const attr = (name: string): string => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? '';
    const file = attr('src');
    const alt = attr('alt').trim();
    const w = numberOf(attr('width').replace(/px$/, ''));
    const h = numberOf(attr('height').replace(/px$/, ''));
    if (!file || file.includes('#') || seen.has(file)) continue;
    seen.add(file);
    // The slide's background, and text drawn as a picture (its text the slide keeps).
    if (w >= size.w * 0.95 && h >= size.h * 0.95) continue;
    if (alt && !FILE_NAME.test(alt) && text.includes(alt)) continue;
    if (!r.finds(file, root)) continue;
    out += imgHtml(file, FILE_NAME.test(alt) ? '' : alt);
  }
  return out;
}

/** A presentation (`presInfo`): its slides as pages in topics, its quizzes' questions, its interactions. */
function presentation(r: Reading, root: string, entry: string, info: Json, opts: ToolReadOptions): ImportedPackage {
  const title = oneLine(str(info.t) || str(info.ct)) || opts.title?.trim() || 'Imported course';
  const slides = records(info.s);
  const size = { w: numberOf(info.w) || 960, h: numberOf(info.h) || 540 };
  const nested = slides.some(s => numberOf(s.l) > 0);
  const chunked = !nested && slides.length >= SLIDES_PER_TOPIC * 2;
  const topics: ImportedTopic[] = [];
  let topic: ImportedTopic | null = null;
  let narrated = 0;
  const addPage = (t: ImportedTopic, pageTitle: string, html: string, path: string): void => {
    const page = r.page(esc(pageTitle), html, root);
    if (page.body.trim()) t.pages.push({ path, title: page.title || pageTitle, body: page.body });
  };
  slides.forEach((s, i) => {
    const where = `${entry}#slides/${i}`;
    const paragraphs = str(s.x).split(/\r\n/).flatMap(shape => shape.split(/[\r\n]/)).map(p => shownText(p)).filter(p => p && !COUNTER.test(p));
    const own = oneLine(str(s.t));
    const first = paragraphs[0] && paragraphs[0].length <= 100 && (paragraphs[0].match(/\p{L}/gu) ?? []).length >= 3 ? paragraphs[0] : '';
    const slideTitle = own || first || `Slide ${i + 1}`;
    if (!topic || (nested && numberOf(s.l) === 0) || (chunked && i % SLIDES_PER_TOPIC === 0)) {
      const last = Math.min(slides.length, i + SLIDES_PER_TOPIC);
      topic = { id: `slides/${i}`, title: nested ? slideTitle : chunked ? `${title}: slides ${i + 1} to ${last}` : title, pages: [], questions: [] };
      topics.push(topic);
    }
    const t = topic;
    if (records(s.S).length) narrated++;
    if (records(s.V).length || records(s.y).length) r.left(where, 'a video, which is not text');
    if (records(s.wo).length) r.left(where, 'a web object, which is not read');
    if (s.st === 'q') {
      const quiz = assigned(r.text(`${root}${str(s.s)}`), 'quizInfo');
      if (!quiz) { r.left(where, 'its quiz is not in the package'); return; }
      readQuiz(r, quiz, () => t, where, addPage);
      return;
    }
    if (s.st === 'i') {
      const d = assigned(r.text(`${root}${str(s.s)}`), 'interactionJson');
      const items = records(isRecord(d?.d) && isRecord(d.d.C) ? d.d.C.is : []);
      const html = items.map(it => `<h2>${esc(richText(it.t))}</h2>${richHtml(it.c)}`).join('');
      const kind = str(s.it).replace(/^iSpring\./, '');
      if (plainText(html)) addPage(t, own || kind || `Slide ${i + 1}`, html, `${root}${str(s.s)}`);
      else r.left(where, 'its interaction is not in the package');
      return;
    }
    const body = paragraphs.filter((p, k) => !(k === 0 && !own && p === first)).map(p => `<p>${esc(p)}</p>`).join('');
    const pictures = slidePictures(r, root, str(s.s), str(s.x), size);
    const notes = str(s.N) || str(s.n).split('\n').map(p => `<p>${esc(p)}</p>`).join('');
    const html = body + pictures + (plainText(notes) ? `<h2>Notes</h2>${notes}` : '');
    if (plainText(html) || pictures) addPage(t, slideTitle, html, `${root}${str(s.s) || `data/slide${i + 1}.js`}`);
  });
  if (narrated) r.left(entry, `narration on ${narrated === 1 ? 'one slide' : `${narrated} slides`}, which is not text`);
  return { title, topics: topics.filter(t => t.pages.length || t.questions.length), unread: r.unread };
}

/**
 * A package iSpring published, read in iSpring's own model: a presentation's slides as pages in
 * topics, and a quiz's questions as iSpring grades them. Null when the package holds no course
 * iSpring published.
 */
export function ispringPackage(files: PackageFiles, opts: ToolReadOptions): ImportedPackage | null {
  const r = new Reading(files, opts.fileUrl);
  const pages = files.names.filter(n => /(^|\/)(?:index|html5)\.html?$/i.test(n)).sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
  for (const entry of pages) {
    const text = r.text(entry);
    if (!text || !MARK.test(text)) continue;
    const root = entry.slice(0, entry.lastIndexOf('/') + 1);
    const info = assigned(text, 'presInfo');
    if (info) return presentation(r, root, entry, info, opts);
    const quiz = assigned(text, 'data') ?? assigned(text, 'quizJson');
    if (!quiz) continue;
    const d = isRecord(quiz.d) ? quiz.d : quiz;
    const title = oneLine(str(d.T)) || opts.title?.trim() || 'Imported quiz';
    const topics: ImportedTopic[] = [];
    if (isRecord(quiz.d)) {
      const groups = records(isRecord(d.sl) ? d.sl.g : []);
      readQuiz(r, quiz, (g, gi) => {
        const t: ImportedTopic = { id: `groups/${gi}`, title: groups.length > 1 ? oneLine(str(g.T)) || `${title}, part ${gi + 1}` : title, pages: [], questions: [] };
        topics.push(t);
        return t;
      }, entry, (t, pageTitle, html, at) => {
        const page = r.page(esc(pageTitle || title), html, root);
        if (page.body.trim()) t.pages.push({ path: at, title: page.title || pageTitle || title, body: page.body });
      });
    } else {
      const t: ImportedTopic = { id: 'quiz', title, pages: [], questions: [] };
      topics.push(t);
      records(quiz.q).forEach((q, qi) => quiz8Question(r, q, t, `${entry}#questions/${qi}`));
    }
    return { title, topics: topics.filter(t => t.pages.length || t.questions.length), unread: r.unread };
  }
  return null;
}
