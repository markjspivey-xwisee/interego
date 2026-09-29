/**
 * A package Rise 360 published (for SCORM 1.2 or 2004, xAPI, or the web), read in Rise's own model
 * rather than as the one page its runtime draws everything into. That page carries the whole
 * course as base64 JSON, in one of three ways, as Rise has written it over the years:
 * - `window.courseData = "…"`;
 * - `deserialize("…")`, inside the page's `__fetchCourse`;
 * - a `window.i18n` naming the default locale, whose `locales/<locale>.js` holds
 *   `__resolveJsonp("course:<locale>", "…")`.
 * The page is `scormcontent/index.html` in a SCORM package, and `index.html` at the root of an xAPI
 * package or of a web export's `content/`. A translated course names its text by id
 * (`{ l10nId }`), and each is read in the course's own language.
 *
 * ★ READ AS RISE HOLDS IT. Each lesson is a topic, in the course's order (the lesson list's, not a
 * `position` field, which is mostly empty). A lesson's blocks are its pages, split where the course
 * asks the learner to continue, and where a page would grow past what a fragment holds, so a long
 * lesson is not one page. A quiz lesson is a topic of its questions, and a section is only a
 * heading in the lesson list. Text, lists, quotes, tables, images and galleries, accordions and
 * tabs, processes, timelines, labeled graphics, flashcards, sorting piles and buttons are read as
 * pages, images the package's own files as Rise's runtime finds them (`assets/` and the image's
 * crushed or original key, or its `src`). A block shows what its variant shows (a review
 * of #578): a paragraph block's leftover heading, a heading block's leftover paragraph and a
 * statement's heading are not the course's text.
 *
 * ★ RIGHT AS RISE GRADES IT. A knowledge check's right answer is each one it flags correct (the
 * first, for one right answer). A quiz question's is the one its `correct` names, or the set its
 * `corrects` names: the flags beside a quiz's answers are often the editor's leftover defaults, and
 * the runtime does not read them. A quiz's fill-in accepts every answer it lists, and a knowledge
 * check's the ones it flags. Letter case counts where Rise says it does (`isCaseSensitive`). A
 * question bank a quiz draws from is asked whole. Options a quiz shuffles are turned
 * (tool-reading.ts).
 *
 * ★ NOTHING INVENTED. Video, audio, embeds, a Storyline block (a package of its own), charts,
 * scenarios, raw HTML, a button to somewhere the package does not hold, and a question that comes
 * with a picture are left out and listed with why, in a block or in one of its items.
 */
import { FRAGMENT_LIMITS } from './content-fragments.js';
import type { ImportedPackage, ImportedTopic, PackageFiles } from './package-import.js';
import { plainText } from './question-banks.js';
import {
  choice, esc, imgHtml, isRecord, Reading, records, SHOWS, str, turned, WITH_MEDIA,
  type Json, type ToolReadOptions,
} from './tool-reading.js';

const COURSE_DATA = /window\.courseData\s*=\s*"([A-Za-z0-9+/=]+)"/;
const DESERIALIZE = /deserialize\(\s*"([A-Za-z0-9+/=]+)"\s*\)/;
const I18N = /window\.i18n\s*=\s*(\{[^;]*\})\s*;/;
const LOCALE = /__resolveJsonp\(\s*"course:[^"]*"\s*,\s*"([A-Za-z0-9+/=]+)"\s*\)/;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const unique = (xs: readonly string[]): string[] => [...new Set(xs)];
/** Plain text a course keeps as it is (a title), as HTML reads it: nothing in it markup. */
const plainOf = (text: unknown): string => plainText(esc(str(text))) ?? '';
/** The media a question or an item can show; anything else under `media` is the editor's scratch (`tmp`). */
const MEDIA = ['image', 'video', 'audio', 'embed', 'attachment', 'storyline'];
/** A block or an item as an element of its own, so its text never runs into the next one's. */
const own = (html: string): string => (html.trim() ? `<div>${html}</div>` : '');
/** How long a page may grow before the next block starts another: what a fragment holds, less room for its title. */
const PAGE_TEXT = FRAGMENT_LIMITS.body - 1000;

interface RiseData { data: Json; folder: string; source: string }

/** A translated course names its text by id (`{ l10nId }`): each is read in the course's own language. */
function delocalized(data: Json): Json {
  const l10n = isRecord(data.l10n) ? data.l10n : null;
  if (!l10n) return data;
  const translations = isRecord(l10n.translations) ? l10n.translations : {};
  const table = isRecord(translations[str(l10n.defaultLocale)]) ? translations[str(l10n.defaultLocale)] as Json : {};
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 64) return v;
    if (Array.isArray(v)) return v.map(x => walk(x, depth + 1));
    if (!isRecord(v)) return v;
    if (typeof v.l10nId === 'string') return str(table[v.l10nId]);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, depth + 1)]));
  };
  return walk(data, 0) as Json;
}

/** The course a Rise page carries, and the folder the page is in; null when no page carries one. */
function riseData(r: Reading, files: PackageFiles): RiseData | null {
  const pages = files.names.filter(n => /(^|\/)index\.html$/i.test(n)).sort((a, b) => a.length - b.length);
  for (const page of pages) {
    const html = r.text(page) ?? '';
    const folder = page.slice(0, page.length - 'index.html'.length);
    let source = page;
    let b64 = COURSE_DATA.exec(html)?.[1] ?? DESERIALIZE.exec(html)?.[1];
    if (!b64) {
      const i18n = I18N.exec(html)?.[1];
      if (!i18n) continue;
      let locale = 'und';
      try {
        const named = (JSON.parse(i18n) as { default?: unknown }).default;
        if (typeof named === 'string' && /^[\w-]+$/.test(named)) locale = named;
      } catch { /* the default locale's file */ }
      source = `${folder}locales/${locale}.js`;
      b64 = LOCALE.exec(r.text(source) ?? '')?.[1];
    }
    if (!b64) continue;
    let data: unknown;
    try { data = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch { continue; }
    if (isRecord(data) && isRecord(data.course) && Array.isArray(data.course.lessons)) return { data: delocalized(data), folder, source };
  }
  return null;
}

/** Where a Rise image is kept, as its runtime finds it: `assets/` and its crushed or original key, or its `src`. */
function riseImage(media: unknown): string {
  const img = isRecord(media) && isRecord(media.image) ? media.image : null;
  if (!img) return '';
  const key = Object.prototype.hasOwnProperty.call(img, 'useCrushedKey')
    ? (img.useCrushedKey === true && str(img.crushedKey) ? str(img.crushedKey) : str(img.key))
    : str(img.src);
  if (!key.trim()) return '';
  const src = /^(?:https?:|data:|\/\/)/i.test(key) ? key : `assets/${key}`;
  return imgHtml(src, str(img.altText) || str(img.alt));
}

/**
 * What an item shows besides its text: its picture, as the page's own; a video, an audio or
 * something embedded is listed with why.
 */
function itemMedia(r: Reading, media: unknown, where: string): string {
  if (!isRecord(media)) return '';
  for (const kind of ['video', 'audio', 'embed']) {
    if (isRecord(media[kind])) r.left(where, `${kind === 'embed' ? 'something embedded from elsewhere' : kind === 'audio' ? 'an audio' : 'a video'} in one of its items, which is not text`);
  }
  return riseImage(media);
}

/** A block as the HTML its page shows; what is not text is listed with why, and shows its caption only. */
function blockHtml(r: Reading, block: Json, where: string, folder: string): string {
  const type = str(block.type);
  const variant = str(block.variant);
  const items = records(block.items);
  const left = (why: string, kept = ''): string => { r.left(where, why); return kept; };
  switch (type) {
    case 'text':
    case 'statement':
      return items.map(it => {
        // Each variant shows its own fields; another variant's are the editor's leftovers. A
        // statement's variants (a to d, a note) show its paragraph.
        const heading = /^(?:sub)?heading(?: paragraph)?$/.test(variant) ? str(it.heading).trim() : '';
        const paragraph = /^(?:sub)?heading$/.test(variant) ? '' : str(it.paragraph);
        const head = !heading ? '' : variant.startsWith('subheading') ? `<h3>${heading}</h3>` : `<h2>${heading}</h2>`;
        return own(`${head}${own(variant === 'note' ? `<blockquote>${paragraph}</blockquote>` : paragraph)}${itemMedia(r, it.media, where)}`);
      }).join('');
    case 'quote':
      return items.map(it => own(`<blockquote>${str(it.paragraph)}</blockquote>${str(it.name).trim() ? `<p>${str(it.name)}</p>` : ''}`)).join('');
    case 'list': {
      const entries = items.map(it => `<li>${str(it.paragraph)}</li>`).join('');
      return variant === 'numbered' ? `<ol>${entries}</ol>` : `<ul>${entries}</ul>`;
    }
    case 'divider':
      return '';
    case 'image':
      // An image beside text shows its paragraph; the others their caption.
      return items.map(it => own(`${riseImage(it.media)}${own(variant === 'text aside' ? str(it.paragraph) : str(it.caption))}`)).join('');
    case 'multimedia': {
      const captions = items.map(it => str(it.caption)).join('');
      if (variant === 'code') return items.map(it => `<pre>${esc(str(it.code))}</pre>${str(it.caption)}`).join('');
      if (variant === 'attachment') {
        return items.map(it => {
          const file = isRecord(it.media) && isRecord(it.media.attachment) ? it.media.attachment : {};
          const key = str(file.key) || str(file.src);
          const name = str(file.originalUrl) || str(file.filename) || key;
          return key ? `<p><a href="${esc(/^(?:https?:)?\/\//i.test(key) ? key : `assets/${key}`)}">${esc(name)}</a></p>` : '';
        }).join('');
      }
      if (variant === 'embed') return left('something embedded from elsewhere, which is not read', captions);
      return left(`${variant === 'audio' ? 'an audio' : 'a video'}, which is not text${captions.trim() ? '; its caption is kept' : ''}`, captions);
    }
    case 'interactive':
      switch (variant) {
        case 'accordion':
        case 'tabs':
          return items.map(it => own(`<h3>${esc(plainOf(it.title))}</h3>${own(str(it.description))}${itemMedia(r, it.media, where)}`)).join('');
        case 'process':
          return items.filter(it => it.isHidden !== true).map(it => own(`${plainOf(it.title) ? `<h3>${esc(plainOf(it.title))}</h3>` : ''}${own(str(it.description))}${itemMedia(r, it.media, where)}`)).join('');
        case 'timeline':
          return items.map(it => own(`<h3>${esc([plainOf(it.date), plainOf(it.title)].filter(Boolean).join(': '))}</h3>${own(str(it.description))}${itemMedia(r, it.media, where)}`)).join('');
        case 'labeledgraphic':
          return riseImage(block.media) + items.map(it => own(`<h3>${esc(plainOf(it.title))}</h3>${own(str(it.description))}${itemMedia(r, it.media, where)}`)).join('');
        case 'flashcard':
        case 'stack':
          return items.map(it => {
            const front = isRecord(it.front) ? it.front : {};
            const back = isRecord(it.back) ? it.back : {};
            // A card's front, its heading (and its picture); its back, what the card teaches.
            return own(`<h3>${esc(plainText(str(front.description)) ?? '')}</h3>${itemMedia(r, front.media, where)}${own(str(back.description))}${itemMedia(r, back.media, where)}`);
          }).join('');
        case 'sorting': {
          const piles = records(block.piles);
          return piles.map(pile => {
            const cards = items.filter(it => String(it.pileId ?? '') === String(pile.id ?? ''));
            return `<h3>${esc(plainOf(pile.title))}</h3><ul>${cards.map(c => `<li>${esc(plainOf(c.title))}</li>`).join('')}</ul>`;
          }).join('');
        }
        case 'button':
        case 'button stack':
          return items.map(it => {
            // What the button says it is for (its description), and where it goes when this
            // bridge can follow it: a web address, one of the package's own files, an address to
            // write to. A button to another lesson, or out of the course, is the player's way on.
            const to = str(it.destination).trim();
            const kind = str(it.type) || 'link';
            const label = plainOf(it.label) || to;
            let link = '';
            if (kind === 'email' && to) link = `<p>${esc(label === to ? to : `${label}: ${to}`)}</p>`;
            else if ((kind === 'link' || kind === 'relative-url') && to && r.finds(to, folder)) link = `<p><a href="${esc(to)}">${esc(label)}</a></p>`;
            else if (to && kind !== 'lesson' && kind !== 'exit-course') r.left(where, `a button to ${to}, which the package does not hold`);
            return own(`${own(str(it.description))}${link}`);
          }).join('');
        case 'storyline':
          return left('a Storyline interaction, which is a package of its own');
        case 'scenario':
          return left('a branching scenario, which is not read');
        default:
          return left(`an interactive ${variant || 'block'}, which is not read`);
      }
    case 'chart':
      return left('a chart, which is drawn rather than written');
    default:
      return left(`a ${[type, variant].filter(Boolean).join(' ') || 'untyped'} block, which is not read`);
  }
}

/** A question as Rise grades it, kept on its topic, or why not, listed. */
function riseQuestion(r: Reading, q: Json, topic: ImportedTopic, where: string, how: { quiz: boolean; shuffle: boolean }): void {
  const type = str(q.type);
  if (type === 'DRAW_FROM_QUESTION_BANK') {
    // A bank a quiz draws from is asked whole: every question in it is one the course may ask.
    records(q.questions).forEach((b, k) => riseQuestion(r, b, topic, `${where}/questions/${k}`, how));
    return;
  }
  const question = plainText(str(q.title));
  if (question === null) { r.left(where, `its question ${SHOWS}`); return; }
  if (!question) { r.left(where, 'its question has no text'); return; }
  // Its picture or video; not the editor's scratch (`media.tmp`), which the runtime never shows.
  if (isRecord(q.media) && MEDIA.some(kind => isRecord((q.media as Json)[kind]))) { r.left(where, WITH_MEDIA); return; }
  const answers = records(q.answers);
  const idOf = (a: Json): string => String(a.id ?? '');
  switch (type) {
    case 'MULTIPLE_CHOICE':
    case 'MULTIPLE_RESPONSE': {
      const options = answers.map(a => plainText(str(a.title)));
      if (options.some(o => o === null)) { r.left(where, `an option ${SHOWS}`); return; }
      const multiple = type === 'MULTIPLE_RESPONSE';
      const named = multiple ? list(q.corrects).map(String) : [String(q.correct ?? '')];
      // A quiz is graded by what its correct/corrects names; a knowledge check by its flags, the first for one right answer.
      const flagged = answers.flatMap((a, i) => (a.correct === true ? [i] : []));
      const right = how.quiz ? answers.flatMap((a, i) => (named.includes(idOf(a)) ? [i] : [])) : multiple ? flagged : flagged.slice(0, 1);
      if (!right.length) { r.left(where, 'it marks no answer correct'); return; }
      const shown = how.shuffle ? turned(options as string[], right, question) : { options: options as string[], right };
      r.keep(topic, choice(question, shown.options, shown.right, multiple), where);
      return;
    }
    case 'FILL_IN_THE_BLANK': {
      // A quiz accepts every answer it lists; a knowledge check, each it flags correct.
      const accepted = unique(answers.filter(a => how.quiz || a.correct === true).map(a => plainOf(a.title).trim()).filter(Boolean));
      if (!accepted.length) { r.left(where, 'it gives no answer'); return; }
      const settings = isRecord(q.settings) ? q.settings : {};
      const caseSensitive = (how.quiz ? settings.isCaseSensitive : q.isCaseSensitive) === true;
      r.keep(topic, {
        question, type: 'fill-in', answer: accepted[0]!,
        ...(accepted.length > 1 ? { accept: accepted.slice(1) } : {}), ...(caseSensitive ? { caseSensitive: true as const } : {}),
      }, where);
      return;
    }
    case 'MATCHING': {
      const pairs = answers.map(a => [plainOf(a.title).trim(), plainOf(a.matchTitle).trim()] as [string, string]);
      if (!pairs.length || pairs.some(([a, b]) => !a || !b)) { r.left(where, 'a pair lacks its prompt or its match'); return; }
      r.keep(topic, { question, type: 'matching', pairs }, where);
      return;
    }
    default:
      r.left(where, `a ${type ? type.toLowerCase().replace(/_/g, ' ') : 'untyped'} question, which is not read`);
  }
}

/**
 * A package Rise 360 published, read in Rise's own model: each lesson a topic of its pages (split
 * where the course asks the learner to continue) and its knowledge checks, each quiz lesson a
 * topic of its questions. Null when the package carries no Rise course.
 */
export function risePackage(files: PackageFiles, opts: ToolReadOptions): ImportedPackage | null {
  const r = new Reading(files, opts.fileUrl);
  const found = riseData(r, files);
  if (!found) return null;
  const { data, folder, source } = found;
  const course = data.course as Json;
  const topics: ImportedTopic[] = [];
  records(course.lessons).forEach((lesson, i) => {
    const kind = str(lesson.type);
    // A section is only a heading in the lesson list.
    if (kind === 'section') return;
    const id = String(lesson.id ?? `lesson-${i + 1}`);
    const title = plainOf(lesson.title) || `Lesson ${i + 1}`;
    const topic: ImportedTopic = { id, title, pages: [], questions: [] };
    const at = (tail = ''): string => `${source}#lessons/${i}${tail}`;
    let html = '';
    let size = 0;
    let part = 1;
    const flush = (): void => {
      if (html.trim()) {
        const read = r.page(esc(part > 1 ? `${title}, part ${part}` : title), html, folder);
        if (read.body.trim()) { topic.pages.push({ path: at(part > 1 ? `/part/${part}` : ''), title: read.title || title, body: read.body }); part++; }
      }
      html = '';
      size = 0;
    };
    if (kind === 'quiz') {
      html = str(lesson.description);
      flush();
      const settings = isRecord(lesson.settings) ? lesson.settings : {};
      records(lesson.items).forEach((q, j) => riseQuestion(r, q, topic, at(`/items/${j}`), { quiz: true, shuffle: settings.shuffleAnswerChoices === true }));
    } else {
      records(lesson.items).forEach((block, j) => {
        const where = at(`/items/${j}`);
        const type = str(block.type);
        // A continue divider is where the course asks the learner to go on: a page ends there.
        if (type === 'divider' && str(block.family) === 'continue') { flush(); return; }
        if (type === 'knowledgeCheck' || type === 'knowledge') {
          const q = records(block.items)[0];
          if (q) riseQuestion(r, q, topic, where, { quiz: false, shuffle: false });
          else r.left(where, 'a knowledge check with no question');
          return;
        }
        const next = own(blockHtml(r, block, where, folder));
        // A page that would grow past what a fragment holds ends before this block.
        const grows = next ? r.page('', next, folder).body.length : 0;
        if (html && size + grows > PAGE_TEXT) flush();
        html += next;
        size += grows + 2;
      });
      flush();
    }
    if (topic.pages.length || topic.questions.length) topics.push(topic);
  });
  const title = plainOf(course.title) || opts.title?.trim() || 'Imported course';
  return { title, topics, unread: r.unread };
}
