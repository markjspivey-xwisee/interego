/**
 * A package Adobe Captivate published (Captivate 8 to 11, its player now called Classic, and the
 * new Captivate, 12.4 and later), for SCORM, xAPI or the web, read in Captivate's own model rather
 * than as the player page its runtime draws each slide into. The course is one JavaScript object
 * literal the player assigns (`cp.D = cp.model.data = {…}`): in assets/js/CPM.js beside the Classic
 * runtime, in assets/js/project.js for the new player. It is read as a literal, never run: a
 * function, a call or `new` in it ends the read. project.txt (JSON) names the generator and, when
 * its author gave one, the title.
 *
 * ★ READ AS CAPTIVATE HOLDS IT. The course's slides, in its order (`project_main.slides`), are its
 * pages: a topic of them (topics of fifty slides, one too long for a composition), each titled by
 * its label. A slide's text is each caption and shape that shows any, in the order a slide shows
 * them (Classic: by when each appears, then top to bottom and left to right; new: as its
 * containers nest), as Captivate keeps it: the new player's rich text (Draft.js) with its lists, a
 * responsive Classic project's HTML, and a fixed Classic project's accessibility text (a Classic
 * slide draws its text as pictures, and keeps only that). A state's copy of an item, buttons, click
 * boxes and a quiz's scaffolding are not the slide's text. Its pictures are the package's own
 * files; its narration's captions are kept. Video, web objects, narration without captions and
 * pictures a Classic project packs into data files (dr/img*.json) are listed with why; so is a
 * quiz's results slide.
 *
 * ★ RIGHT AS CAPTIVATE GRADES IT. A question slide is a question: a choice right as its answers are
 * marked (`ic`, or the correct list the question names), a blank or a short answer accepting each
 * answer it lists (letter case as it says, the reply compared whole), a match pairing what it pairs,
 * an order as the question keeps it. Answers the question shuffles (`sra`) are turned
 * (tool-reading.ts). A survey, a hotspot, a Likert scale and a question with no answer are left
 * out, with why; so is an object scored as a question (a click on it, a drag onto it), whose slide
 * is read as a page. The question's own text is read from the slide, not from `qt`, which
 * Captivate does not keep in step with it.
 */
import { decodeEntities, type ImportedPackage, type ImportedTopic, type PackageFiles } from './package-import.js';
import { plainText } from './question-banks.js';
import { choice, esc, imgHtml, isRecord, jsStringAt, literalAt, numberOf, Reading, records, str, turned, type Json, type ToolReadOptions } from './tool-reading.js';

/** A course too long for one composition becomes topics of this many slides each. */
const SLIDES_PER_TOPIC = 50;
/** The mark a Classic slide's accessibility text puts between a caption's paragraphs. */
const PARAGRAPH = String.fromCharCode(3);
/** Items whose text is the slide's: a caption, a title placeholder, a smart shape, the new player's text. */
const TEXT = new Set([19, 589, 612, 683, 1250]);
const IMAGE = 15;
const VIDEO = new Set([98, 270, 365]);
const WEB_OBJECT = 652;
/** A results slide's score and its labels. */
const RESULTS = new Set([111, 112]);
/** An object on a slide scored as a question: a click on it, or a drag onto it. */
const OBJECTS_SCORED = new Set(['InteractiveItemQuestion', 'DragDropQuestion']);
/** A variable the player fills in: `$$name$$` (Classic), `@#{101}` (new). */
const VARIABLE = /\$\$[\w.]+\$\$|@#\{\d+\}/g;
const FILE_NAME = /\.(?:png|jpe?g|gif|svg|webp|bmp|emf|wmf)$/i;

/** The course's data: the literal the player assigns to `cp.model.data`. */
function courseData(text: string | null): Json | null {
  if (!text) return null;
  const m = /cp\.model\.data\s*=\s*\{/.exec(text) ?? /cp\.D\s*=\s*\{/.exec(text);
  if (!m) return null;
  const read = literalAt(text, m.index + m[0].length - 1);
  return read && isRecord(read.value) ? read.value : null;
}

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim();
const shown = (t: string): string => t.replace(VARIABLE, '…');

/** The new player's rich text (Draft.js raw, a JSON string) as HTML: its blocks, headings and lists. */
function draftHtml(raw: unknown): string {
  let doc: unknown;
  try { doc = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return ''; }
  const blocks = records(isRecord(doc) ? doc.blocks : isRecord(doc) && isRecord(doc.editorState) ? doc.editorState.blocks : []);
  let html = '';
  let list = '';
  const close = (): void => { if (list) html += list === 'ol' ? '</ol>' : '</ul>'; list = ''; };
  for (const b of blocks) {
    const text = shown(str(b.text)).trim();
    const type = str(b.type);
    const want = type === 'ordered-list-item' ? 'ol' : type === 'unordered-list-item' ? 'ul' : '';
    if (want) {
      if (list !== want) { close(); html += want === 'ol' ? '<ol>' : '<ul>'; list = want; }
      if (text) html += `<li>${esc(text)}</li>`;
      continue;
    }
    close();
    if (!text) continue;
    html += type === 'header-one' ? `<h2>${esc(text)}</h2>` : /^header-/.test(type) ? `<h3>${esc(text)}</h3>` : `<p>${esc(text)}</p>`;
  }
  close();
  return html;
}

/** A Classic slide's accessibility text as HTML: a paragraph for each mark between them. */
function accessibleHtml(acc: unknown): string {
  const t = typeof acc === 'string' ? acc : isRecord(acc) ? str(Object.values(acc)[0]) : '';
  return t.split(PARAGRAPH).map(p => shown(p).replace(/\s+/g, ' ').trim()).filter(Boolean).map(p => `<p>${esc(p)}</p>`).join('');
}

class Captivate {
  readonly r: Reading;
  /** A responsive Classic project, whose items keep their text as HTML. A fixed one draws it as pictures, and keeps only its accessibility text. */
  readonly responsive: boolean;
  /** The new player (12.4 and later), whose text is rich text and whose items nest in containers. */
  readonly modern: boolean;
  packedPictures = 0;

  constructor(files: PackageFiles, fileUrl: (path: string) => string, readonly D: Json, readonly root: string) {
    this.r = new Reading(files, fileUrl);
    const main = isRecord(D.project_main) ? D.project_main : {};
    this.responsive = main.useResponsive === true;
    this.modern = isRecord(main.featureFlags) || Object.values(D).some(v => isRecord(v) && v.type === 1268);
  }

  item(key: string): Json { return isRecord(this.D[key]) ? this.D[key] as Json : {}; }
  /** An item's display object: its geometry, its picture, its accessibility text. */
  display(key: string): Json {
    const it = this.item(key);
    return isRecord(this.D[str(it.mdi)]) ? this.D[str(it.mdi)] as Json : this.item(`${key}c`);
  }

  /** What an item shows as text, as HTML. */
  textOf(key: string): string {
    const it = this.item(key);
    if (it.text !== undefined && str(it.text).trim().startsWith('{')) return draftHtml(it.text);
    if (this.responsive) {
      const vt = str(it.vt) || (isRecord(it.rpvt) ? str((Object.values(it.rpvt).find(isRecord) as Json | undefined)?.vt) : '');
      if (vt.trim()) return shown(vt);
    }
    return accessibleHtml(this.display(key).accstr);
  }

  /** An item's picture, the package's own file; or none, and why when the package packed it. */
  pictureOf(key: string): string {
    const c = this.display(key);
    const file = str(c.ip);
    if (!file) return '';
    if (!this.r.finds(file, this.root)) { this.packedPictures++; return ''; }
    const alt = oneLine(accessibleHtml(c.accstr).replace(/<[^>]+>/g, ' '));
    return imgHtml(file, !alt || /^image$/i.test(alt) || FILE_NAME.test(alt) ? '' : alt);
  }

  /** A slide's items, in the order it shows them. */
  itemsOf(slide: Json): Array<{ key: string; type: number }> {
    const out: Array<{ key: string; type: number; from: number; top: number; left: number; i: number }> = [];
    // Each item once, however many containers name it: a slide is read in one pass.
    const seen = new Set<string>();
    const walk = (list: unknown, depth: number): void => {
      if (depth > 32) return;
      for (const ref of records(list)) {
        const key = str(ref.n);
        if (seen.has(key)) continue;
        seen.add(key);
        const it = this.item(key);
        // A state's copy of an item (RollOver, Down) is not more of the slide.
        if (it.bstin !== undefined) continue;
        const shape = this.display(key).b;
        const b = Array.isArray(shape) ? shape : [];
        out.push({ key, type: numberOf(ref.t), from: numberOf(it.from), top: numberOf(b[1]), left: numberOf(b[0]), i: out.length });
        walk(it.si, depth + 1);
      }
    };
    walk(slide.si, 0);
    if (this.modern) return out;
    const n = (x: number): number => (Number.isFinite(x) ? x : 0);
    return out.sort((a, b) => n(a.from) - n(b.from) || n(a.top) - n(b.top) || n(a.left) - n(b.left) || a.i - b.i);
  }
}


/** Parsed JSON a new-format item keeps as a string (`widgetProps`), or nothing. */
function props(it: Json): Json {
  try { const v: unknown = JSON.parse(str(it.widgetProps) || '{}'); return isRecord(v) ? v : {}; } catch { return {}; }
}

/** A question slide's question, as Captivate grades it, kept on its topic, or why not, listed. */
function captivateQuestion(cp: Captivate, slide: Json, q: Json, topic: ImportedTopic, where: string): void {
  const { r, D } = cp;
  const itp = str(q.itp);
  const qtp = str(q.qtp);
  if (q.is === true) { r.left(where, 'a survey question, which grades nothing'); return; }
  if (itp === 'hotspot') { r.left(where, 'a hotspot question, which a check here would not show'); return; }
  if (itp === 'likert') { r.left(where, 'a survey question, which grades nothing'); return; }
  const items = cp.itemsOf(slide);
  const tagged = (tag: string | RegExp): Array<{ key: string; it: Json }> => items
    .map(x => ({ key: x.key, it: cp.item(x.key) }))
    .filter(x => (typeof tag === 'string' ? str(x.it.tag) === tag : tag.test(str(x.it.tag))));
  const numbered = (tag: string): Array<{ key: string; it: Json }> => tagged(new RegExp(`^${tag}\\d+$`))
    .sort((a, b) => numberOf(str(a.it.tag).slice(tag.length)) - numberOf(str(b.it.tag).slice(tag.length)));
  // The question's own words: the new player's question text (or title); Classic's question-text
  // item (`qtc`), not the `qt` Captivate does not keep in step with it.
  const qtc = str(q.qtc).replace(/c$/, '');
  const promptHtml = cp.modern
    ? (tagged('slide-item-question-text')[0] ?? tagged('slide-item-question-title')[0]) ? cp.textOf((tagged('slide-item-question-text')[0] ?? tagged('slide-item-question-title')[0])!.key) : ''
    : qtc ? cp.textOf(qtc) : '';
  const prompt = (plainText(promptHtml) ?? '').trim();
  const plain = (html: string): string => oneLine(plainText(html) ?? '');
  const shuffles = q.sra === true;

  switch (itp) {
    case 'choice':
    case 'true-false': {
      let options: string[];
      let right: number[];
      let multiple: boolean;
      if (cp.modern) {
        const answers = (Array.isArray(q.ail) ? q.ail : []).map(k => ({ key: str(k), it: cp.item(str(k)) }));
        const labelled = answers.map(a => {
          const p = props(a.it);
          const blocks = isRecord(p.normal) && isRecord(p.normal.editorState) ? records(p.normal.editorState.blocks) : [];
          return { text: oneLine(shown(blocks.map(b => str(b.text)).join('\n'))), picture: p.isImageActive === true };
        });
        if (labelled.some(l => !l.text || l.picture)) { r.left(where, 'a choice is a picture, which a check here would not show'); return; }
        options = labelled.map(l => l.text);
        const named = new Set((Array.isArray(q.cal) ? q.cal : []).map(String));
        right = answers.flatMap((a, i) => (named.has(a.key) || a.it.ic === true ? [i] : []));
        multiple = right.length > 1;
      } else {
        const answers = (Array.isArray(q.ao) ? q.ao : []).map(ref => (isRecord(D[String(ref).split(':')[0]!]) ? D[String(ref).split(':')[0]!] as Json : {}));
        options = answers.map(a => oneLine(shown(str(a.atxtlms))) || plain(accessibleHtml(a.accstr)));
        if (!options.length || options.some(o => !o)) { r.left(where, 'a choice is a picture, which a check here would not show'); return; }
        const named = new Set((Array.isArray(q.cal) ? q.cal : []).map(String));
        right = answers.flatMap((a, i) => (a.ic === true || (named.size > 0 && named.has(str(a.aid))) ? [i] : []));
        multiple = answers.some(a => numberOf(a.at) === 10081) || right.length > 1;
      }
      if (!right.length) { r.left(where, 'it marks no answer correct'); return; }
      if (!prompt) { r.left(where, 'its question has no text'); return; }
      const turnedTo = shuffles ? turned(options, right, prompt) : { options, right };
      r.keep(topic, choice(prompt, turnedTo.options, turnedTo.right, multiple), where);
      return;
    }
    case 'fill-in': {
      // A blank in a phrase (Classic): its answers, and the phrase with "dash" where the blank is.
      const blanks = (Array.isArray(q.ao) ? q.ao : []).map(ref => (isRecord(D[String(ref).split(':')[0]!]) ? D[String(ref).split(':')[0]!] as Json : {}));
      const blank = blanks[0];
      if (!blank || blanks.length > 1) { r.left(where, blank ? 'it has several blanks, and a question here asks one' : 'it has no blank'); return; }
      const phrase = plain(accessibleHtml(isRecord(D[`${str(blank.capN)}c`]) ? (D[`${str(blank.capN)}c`] as Json).fibText ?? (D[`${str(blank.capN)}c`] as Json).accstr : '')).replace(/\bdash\b/, '____');
      const asked = [prompt, phrase.includes('____') ? phrase : ''].filter(Boolean).join('\n\n');
      if (!asked) { r.left(where, 'its question has no text'); return; }
      const answers = [...new Set((Array.isArray(blank.correctAnswers) ? blank.correctAnswers : []).map(a => str(a).trim()).filter(Boolean))];
      if (!answers.length) { r.left(where, 'it gives no answer'); return; }
      if (blank.sac === true) {
        // A list to choose from: its options, the right one the answer it names.
        const options = [...new Set((Array.isArray(blank.allAnswers) ? blank.allAnswers : []).map(a => str(a).trim()).filter(Boolean))];
        const right = options.indexOf(answers[0]!);
        if (options.length < 2 || right < 0) { r.left(where, 'its list does not name its answer'); return; }
        const t = shuffles ? turned(options, [right], asked) : { options, right: [right] };
        r.keep(topic, choice(asked, t.options, t.right, false), where);
        return;
      }
      const [first, ...rest] = answers;
      r.keep(topic, { question: asked, type: 'fill-in', answer: first!, ...(rest.length ? { accept: rest } : {}), ...(blank.cs === true ? { caseSensitive: true as const } : {}), compare: 'exact' }, where);
      return;
    }
    case 'long-fill-in': {
      let answers: string[];
      let caseSensitive: boolean;
      if (cp.modern) {
        const field = tagged('slide-item-answer-inputfield')[0];
        const p = field ? props(field.it) : {};
        const input = isRecord(p.inputFieldProps) ? p.inputFieldProps : {};
        answers = (Array.isArray(input.answersList) ? input.answersList : []).map(a => str(a).trim()).filter(Boolean);
        caseSensitive = input.enableCaseSensitive === true;
      } else {
        answers = (Array.isArray(q.cal) ? q.cal : []).map(a => str(a).trim()).filter(Boolean);
        const sha = (Array.isArray(q.ao) ? q.ao : []).map(ref => D[String(ref).split(':')[0]!]).find(isRecord) as Json | undefined;
        caseSensitive = sha?.cs === true;
      }
      // With no answer listed, any reply is right: that is a reflection, not a question.
      if (!answers.length) { r.left(where, 'it lists no answer, so any reply is right'); return; }
      if (!prompt) { r.left(where, 'its question has no text'); return; }
      const [first, ...rest] = [...new Set(answers)];
      r.keep(topic, { question: prompt, type: 'fill-in', answer: first!, ...(rest.length ? { accept: rest } : {}), ...(caseSensitive ? { caseSensitive: true as const } : {}), compare: 'exact' }, where);
      return;
    }
    case 'matching': {
      let pairs: Array<[string, string]>;
      if (cp.modern) {
        const prompts = numbered('slide-item-question-text');
        const lists = numbered('slide-item-answer-dropdown');
        pairs = prompts.map((p, i) => {
          const list = lists[i];
          const options = list ? (() => { const s = props(list.it).selected; return isRecord(s) && isRecord(s.container) && Array.isArray(s.container.options) ? s.container.options.map(o => oneLine(str(o))) : []; })() : [];
          return [plain(cp.textOf(p.key)), list ? options[numberOf(list.it.dca)] ?? '' : ''] as [string, string];
        });
      } else {
        const col = (refs: unknown): Json[] => (Array.isArray(refs) ? refs : []).map(ref => (isRecord(D[String(ref).split(':')[0]!]) ? D[String(ref).split(':')[0]!] as Json : {}));
        const targets = new Map(col(q.aco).map(t => [str(t.aid), oneLine(shown(str(t.atxtlms))) || plain(accessibleHtml(t.accstr))] as const));
        // Column 1's aid is the letter of the entry in column 2 it matches.
        pairs = col(q.aio).map(p => [oneLine(shown(str(p.aAnsTxtlms))) || plain(accessibleHtml(p.accstr)), targets.get(str(p.aid)) ?? ''] as [string, string]);
      }
      if (!pairs.length || pairs.some(([p, a]) => !p || !a)) { r.left(where, 'a match is a picture, or names what it does not hold'); return; }
      r.keep(topic, { question: prompt || 'Match each item.', type: 'matching', pairs }, where);
      return;
    }
    case 'sequencing': {
      let items: string[];
      if (cp.modern) items = numbered('slide-item-answer-text').map(x => plain(cp.textOf(x.key)));
      else {
        // Its correct order names each answer by its display object (or, in older projects, its id).
        const answers = (Array.isArray(q.ao) ? q.ao : []).map(ref => String(ref).split(':')[0]!).filter(k => isRecord(D[k])).map(k => ({ key: k, a: D[k] as Json }));
        const textOf = (a: Json): string => oneLine(shown(str(a.atxtlms))) || plain(str(a.atxt)) || plain(accessibleHtml(a.accstr));
        items = (Array.isArray(q.cal) ? q.cal : []).map(id => { const x = answers.find(y => y.key === str(id) || str(y.a.aid) === str(id)); return x ? textOf(x.a) : ''; });
      }
      if (items.length < 2 || items.some(i => !i)) { r.left(where, 'its order names what it does not hold'); return; }
      if (new Set(items.map(i => i.toLowerCase())).size !== items.length) { r.left(where, 'two of its items read the same, so which is which is only where each is'); return; }
      r.keep(topic, { question: prompt || 'Put these in order.', type: 'sequencing', items }, where);
      return;
    }
    default:
      r.left(where, itp || qtp ? `a question of the kind "${itp || qtp}", which is not read` : 'a question of a kind it does not name, which is not read');
  }
}

/** A slide's closed captions (its narration's words), as HTML: Classic keeps them per width, the new player as rich text. */
function captionsOf(slide: Json): string {
  const cc = slide.audCC;
  if (typeof cc === 'string' && cc.trim()) {
    let list: unknown;
    try { list = JSON.parse(cc.trim().replace(/^"|"$/g, '')); } catch { list = []; }
    return records(list).map(c => draftHtml(c.editorState)).join('');
  }
  return records(cc).map(c => {
    const byWidth = isRecord(c.t) ? Object.values(c.t).map(v => str(v)).find(Boolean) ?? '' : str(c.t);
    return byWidth ? `<p>${byWidth}</p>` : '';
  }).join('');
}

/**
 * A package Captivate published, read in Captivate's own model: its slides as pages, its question
 * slides as questions, graded as Captivate grades them: the course whose data file is `at`, else
 * the package's shallowest. Null when there is no course Captivate published there.
 */
export function captivatePackage(files: PackageFiles, opts: ToolReadOptions, at?: string): ImportedPackage | null {
  const dataFile = at ?? files.names.filter(n => /(^|\/)assets\/js\/(?:CPM|project)\.js$/.test(n)).sort((a, b) => a.length - b.length)[0];
  if (!dataFile) return null;
  const root = dataFile.slice(0, dataFile.length - dataFile.split('/').slice(-3).join('/').length);
  const probe = new Reading(files, opts.fileUrl);
  const source = probe.text(dataFile);
  const D = courseData(source);
  const main = D && isRecord(D.project_main) ? D.project_main : null;
  if (!D || !main) return null;
  const cp = new Captivate(files, opts.fileUrl, D, root);
  const { r } = cp;
  let meta: Json = {};
  try { const v: unknown = JSON.parse(r.text(`${root}project.txt`) ?? '{}'); meta = isRecord(v) && isRecord(v.metadata) ? v.metadata : {}; } catch { /* no project.txt */ }
  // The project's name as the Classic player sets it: a string literal, its escapes decoded.
  const named = /cp\.cv\(\s*'cpInfoProjectName'\s*,\s*(?=['"])/.exec(source ?? '');
  const projectName = named && source ? jsStringAt(source, named.index + named[0].length)?.value ?? '' : '';
  const page = decodeEntities(/<title>([^<]*)<\/title>/i.exec(r.text(`${root}index.html`) ?? r.text(`${root}index_scorm.html`) ?? '')?.[1] ?? '');
  const file = isRecord(D.project) ? str(D.project.pN).replace(/\.cptx?$/i, '') : '';
  const title = [str(meta.title), projectName, page, file].map(t => oneLine(t)).find(Boolean) || opts.title?.trim() || 'Imported course';

  const slides = str(main.slides).split(',').map(s => s.trim()).filter(Boolean);
  const chunked = slides.length >= SLIDES_PER_TOPIC * 2;
  const topics: ImportedTopic[] = [];
  let topic: ImportedTopic | null = null;
  let narrated = 0;
  const audio = Object.entries(D).filter(([k, v]) => /^StAd\d+$/.test(k) && isRecord(v)).map(([, v]) => v as Json);
  slides.forEach((key, i) => {
    const slide = cp.item(key);
    const where = `${dataFile}#${key}`;
    if (!topic || (chunked && i % SLIDES_PER_TOPIC === 0)) {
      const last = Math.min(slides.length, i + SLIDES_PER_TOPIC);
      topic = { id: chunked ? `slides-${i + 1}` : 'slides', title: chunked ? `${title}: slides ${i + 1} to ${last}` : title, pages: [], questions: [] };
      topics.push(topic);
    }
    const label = oneLine(shown(str(slide.lb)));
    const slideTitle = label || `Slide ${i + 1}`;
    // Narration: an audio clip the slide's frames play, or one the new player ties to it.
    const from = numberOf(slide.from);
    const to = numberOf(slide.to);
    const heard = audio.some(a => records(a.saup).some(s => str(s.sn) === key) || (numberOf(a.from) >= from && numberOf(a.from) <= to));
    const captions = captionsOf(slide);
    if (heard && !plainText(captions)) narrated++;
    // A question slide's question. Objects on a slide can be scored too (a click on one, a drag
    // onto one), which asks nothing a check here could: that slide is a page, and they are listed.
    const scored = str(slide.qs).split(',').map(k => k.trim()).filter(Boolean).map(k => cp.item(k));
    const q = scored.find(s => !OBJECTS_SCORED.has(str(s.qtp)));
    if (q) { captivateQuestion(cp, slide, q, topic, where); return; }
    if (scored.length) r.left(where, scored.length === 1 ? 'an object scored as a question (a click or a drag), which is not read' : `${scored.length} objects scored as questions (a click or a drag), which are not read`);
    const items = cp.itemsOf(slide);
    if (numberOf(slide.type) === 102 || items.some(x => RESULTS.has(x.type))) { r.left(where, "a quiz's results slide: the score it shows is a running course's"); return; }
    let html = '';
    for (const { key: k, type } of items) {
      const it = cp.item(k);
      const tag = str(it.tag);
      // A shape used as a button (`uab`) is the player's way on, not the slide's text.
      if (it.uab === 1 || it.uab === true) continue;
      if (VIDEO.has(type)) { r.left(where, 'a video, which is not text'); continue; }
      if (type === WEB_OBJECT) { r.left(where, 'a web object, which is not read'); continue; }
      if (type === IMAGE) { html += cp.pictureOf(k); continue; }
      if (!TEXT.has(type) || /^slide-item-(?:progress|.*button|question-(?:review-)?caption)/.test(tag)) continue;
      html += cp.textOf(k);
    }
    if (plainText(captions)) html += `<h2>Narration</h2>${captions}`;
    const read = html.trim() ? r.page(esc(slideTitle), html, root) : { title: '', body: '' };
    if (read.body.trim()) topic.pages.push({ path: where, title: read.title || slideTitle, body: read.body });
  });
  if (narrated) r.left(dataFile, `narration on ${narrated === 1 ? 'one slide' : `${narrated} slides`}, with no captions, which is not text`);
  if (cp.packedPictures) r.left(dataFile, `${cp.packedPictures === 1 ? 'a picture' : `${cp.packedPictures} pictures`} packed into the player's data files (dr/img*.json), which are not served`);
  return { title, topics: topics.filter(t => t.pages.length || t.questions.length), unread: r.unread };
}
