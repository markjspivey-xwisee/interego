/**
 * A package Storyline published (Storyline 360 or Storyline 3, for SCORM, xAPI or the web), read in
 * Storyline's own model rather than as the player page its runtime draws each slide into. The
 * course is JSON in `html5/data/js/`, each file one `globalProvideData('<type>', '<JSON>')` call
 * whose JSON is a single-quoted JavaScript string, decoded here without running anything:
 * - `data.js`: the scenes and their slides, the question banks scenes draw from, each question's
 *   definition, and the asset library (each picture's file);
 * - one file per slide: its layers and their objects, and the text each object shows;
 * - `frame.js`: the player's menu (the only place a scene has a title) and the slides' notes.
 * The course's title is the one `meta.xml` gives, else the launch page's, else the player's.
 *
 * ★ READ AS STORYLINE HOLDS IT. Each scene is a topic (a scene too long for one composition, topics
 * of fifty slides), each content slide a page: its layers' text in the order a screen reader reads
 * it (`tabIndex`), headings and lists as their style marks them, its pictures the package's own
 * files, and its notes. A group that changes with its state shows the text of its first state.
 * Text drawn as a picture is listed, not guessed at; so are video, web objects and narration. A
 * variable's value (`%_player.Name%`) is only a running course's, so it reads as "…"; a quiz's
 * results slide, which shows only such values, is left out.
 *
 * ★ RIGHT AS STORYLINE GRADES IT. A question's right answer is the one its definition marks
 * correct: the choices it names, the pairs it matches, the order it asks for, the values it
 * compares. A fill-in accepts each answer it lists, its letter case as each says (answers that
 * differ in that are no one question here). A question built from a form keeps the choices the form
 * names; a free-form one's choices are objects on the slide, read as the slide shows them. A
 * question's text is its own when the slide shows it, with any longer text beside it (a passage it
 * asks about); else the slide's text, without a counter or a variable. Choices the slide shuffles
 * are turned (tool-reading.ts). A bank a scene draws from is asked whole. Surveys, hotspots and
 * essays are left out, with why.
 */
import { decodeEntities, type ImportedPackage, type ImportedTopic, type PackageFiles } from './package-import.js';
import { plainText } from './question-banks.js';
import { choice, esc, imgHtml, isRecord, numberOf, Reading, records, str, turned, type Json, type ToolReadOptions } from './tool-reading.js';

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
/** A scene longer than a composition holds becomes topics of this many slides each. */
const SLIDES_PER_TOPIC = 50;
/** A variable a running course fills in: `%_player.Name%`. A percent sign written as text is `^%^`. */
const VARIABLE = /%[A-Za-z_][\w.$#]*%/g;
/** Text that is only a number or a question's number ("1.", "01", "3/10"): a counter, not a question. */
const COUNTER = /^[\d\s./()-]+$/;
/** A picture's alt text that is only its file's name. */
const FILE_NAME = /\.(?:png|jpe?g|gif|svg|webp|bmp|emf|wmf|tiff?)$/i;
/** Objects that show the learner's own answer, not the question's: a review banner or shape. */
const REVIEW = /_(?:CorrectReview|IncorrectReview|ReviewShape)$/;
/** The objects of a question built from a form, whose text is the form's choices. */
const FORM_PARTS = new Set(['dragitem', 'droparea']);

/** A Storyline data file's JSON, when the file is one of `type`: decoded from its single-quoted string, never run. */
export function provided(text: string | null, type: string): Json | null {
  if (!text) return null;
  const m = /globalProvideData\(\s*(['"])(\w+)\1\s*,\s*'/.exec(text);
  if (!m || m[2] !== type) return null;
  let out = '';
  let i = m.index + m[0].length;
  for (;;) {
    const quote = text.indexOf("'", i);
    const slash = text.indexOf('\\', i);
    if (quote < 0) return null;
    if (slash < 0 || quote < slash) { out += text.slice(i, quote); break; }
    out += text.slice(i, slash);
    const n = text[slash + 1] ?? '';
    if (n === 'u') { out += String.fromCharCode(parseInt(text.slice(slash + 2, slash + 6), 16)); i = slash + 6; }
    else if (n === 'x') { out += String.fromCharCode(parseInt(text.slice(slash + 2, slash + 4), 16)); i = slash + 4; }
    else { out += ESCAPES[n] ?? n; i = slash + 2; }
  }
  try { const v = JSON.parse(out); return isRecord(v) ? v : null; } catch { return null; }
}

/** Text as a slide shows it, and whether a variable fills part of it: its value is a running course's. */
function shown(t: string): { text: string; variable: boolean } {
  const text = t.replace(VARIABLE, '…');
  return { text: text.replace(/\^%\^/g, '%'), variable: text !== t };
}

/** A text's blocks as HTML: each a paragraph, a heading or a list item, as its style marks it. */
function blocksHtml(blocks: Json[]): { html: string; variable: boolean } {
  let html = '';
  let list = '';
  let variable = false;
  const close = (): void => { if (list) html += list === 'ol' ? '</ol>' : '</ul>'; list = ''; };
  for (const b of blocks) {
    const s = shown(records(b.spans).map(sp => str(sp.text)).join('').replace(/\n$/, ''));
    variable ||= s.variable;
    const style = isRecord(b.style) ? b.style : {};
    const listType = isRecord(style.listStyle) ? str(style.listStyle.listType) : '';
    if (listType && listType !== 'none') {
      const want = /number|arabic|roman|alpha/i.test(listType) ? 'ol' : 'ul';
      if (list !== want) { close(); html += want === 'ol' ? '<ol>' : '<ul>'; list = want; }
      html += `<li>${esc(s.text)}</li>`;
      continue;
    }
    close();
    if (!s.text.trim()) continue;
    const tag = str(style.tagType).toUpperCase();
    html += tag === 'H1' ? `<h2>${esc(s.text)}</h2>` : /^H[2-6]$/.test(tag) ? `<h3>${esc(s.text)}</h3>` : `<p>${esc(s.text)}</p>`;
  }
  close();
  return { html, variable };
}

/**
 * What an object shows as text, as HTML: its default state's text, as blocks or HTML, else (text
 * drawn as a shape) its alt text. A text only another state shows is not the object's: a shape
 * without text of its own has its name for alt text ("Rectangle 1").
 */
function objectHtml(o: Json): { html: string; variable: boolean } {
  const id = str(o.id);
  const td = records(o.textLib).length
    ? records(o.textLib).find(t => str(t.linkId) === `txt__default_${id}` || str(t.linkId) === `txt_${id}`)
    : isRecord(o.data) && isRecord(o.data.textdata) ? o.data.textdata : undefined;
  const none = { html: '', variable: false };
  if (!td) return none;
  const vt = td.vartext;
  if (isRecord(vt) && Array.isArray(vt.blocks)) return blocksHtml(records(vt.blocks));
  if (typeof vt === 'string' && vt.trim()) { const s = shown(vt); return { html: s.text, variable: s.variable }; }
  const alt = str(td.altText) || (isRecord(o.data) && isRecord(o.data.vectorData) ? str(o.data.vectorData.altText) : '');
  if (!alt.trim()) return none;
  const s = shown(alt.trim());
  return { html: s.text.split(/\n+/).map(p => `<p>${esc(p)}</p>`).join(''), variable: s.variable };
}

function descendants(o: Json, depth = 0): Json[] {
  return depth > 16 ? [] : records(o.objects).flatMap(c => [c, ...descendants(c, depth + 1)]);
}

/** An object where a layer shows it, and the objects it sits in, outermost first. */
interface Placed { o: Json; within: string[] }

/**
 * A layer's objects, nested ones too, in the order a screen reader reads them. A group that changes
 * with its state (`stategroup`) holds a copy of its text for each state: it is read as the first.
 */
function readingOrder(objects: unknown): Placed[] {
  const all: Placed[] = [];
  const walk = (list: unknown, within: string[]): void => {
    if (within.length > 16) return;
    for (const o of records(list)) {
      const inside = [...within, str(o.id)];
      if (str(o.kind) === 'stategroup') {
        const first = descendants(o).find(d => objectHtml(d).html);
        if (first) all.push({ o: first, within: inside });
        continue;
      }
      all.push({ o, within });
      walk(o.objects, inside);
    }
  };
  walk(objects, []);
  const at = (o: Json): number => { const n = numberOf(o.tabIndex); return Number.isFinite(n) && n >= 0 ? n : Number.MAX_SAFE_INTEGER; };
  return all.map((p, i) => ({ p, i })).sort((a, b) => at(a.p.o) - at(b.p.o) || a.i - b.i).map(x => x.p);
}

/** One object's text on a slide: whose it is (the object and those it sits in), and whether a variable fills it. */
interface Piece { id: string; kind: string; within: string[]; text: string; variable: boolean }

interface SlideRead {
  html: string;
  pieces: Piece[];
  /** Objects a shuffle group shows in a shuffled order. */
  shuffled: Set<string>;
  /** Whether it shows shapes Storyline drew as pictures (and any text in them). */
  drawn: boolean;
  /** Whether it shows a picture or a video. */
  pictured: boolean;
  narrated: boolean;
  media: string[];
  /** A quiz's results slide: it evaluates the quiz, and shows its score. */
  results: boolean;
}

class Storyline {
  readonly r: Reading;
  private readonly assets: Json[];

  constructor(files: PackageFiles, fileUrl: (path: string) => string, data: Json, private readonly root: string) {
    this.r = new Reading(files, fileUrl);
    this.assets = records(data.assetLib);
  }

  /** A picture's files: the asset library's (the HTML5 player's), then the object's own. */
  private picture(assetId: unknown, own: unknown): string[] {
    const byIndex = this.assets[Number(assetId)];
    const asset = byIndex && (byIndex.id === undefined || String(byIndex.id) === String(assetId)) ? byIndex : this.assets.find(a => String(a.id) === String(assetId));
    return [str(asset?.url), str(own)].filter(u => u && !/\.swf$/i.test(u));
  }

  /** A slide's layers, from its own file: the base layer only, for a question (the others are its feedback). */
  slide(html5url: string, questionSlide: boolean): SlideRead {
    const read: SlideRead = { html: '', pieces: [], shuffled: new Set(), drawn: false, pictured: false, narrated: false, media: [], results: false };
    const slide = provided(this.r.text(`${this.root}${html5url}`), 'slide');
    if (!slide) return read;
    read.results = !questionSlide && /\.EvaluateQuiz"/.test(JSON.stringify(slide));
    const layers = records(slide.slideLayers);
    const shown = questionSlide ? layers.filter((l, i) => l.isBaseLayer === true || (i === 0 && !layers.some(x => x.isBaseLayer === true))) : layers;
    const seen = new Set<string>();
    for (const layer of shown) {
      if (records(layer.audiolib).length) read.narrated = true;
      for (const { o, within } of readingOrder(layer.objects)) {
        const id = str(o.id);
        const kind = str(o.kind);
        if (kind === 'shufflegroup' && o.shuffle === true) for (const inner of descendants(o)) read.shuffled.add(str(inner.id));
        // A layer repeats the objects it shares with another; each is read once.
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        if (str(o.accType) === 'button' || REVIEW.test(id) || kind === 'textinput' || kind === 'droplist') continue;
        if (kind === 'video') { read.pictured = true; read.media.push('a video, which is not text'); continue; }
        if (kind === 'webobject') { read.media.push('a web object, which is not read'); continue; }
        const pictures = [...records(o.imagelib).map(im => ({ id: im.assetId, url: im.url, alt: str(im.altText) })),
          ...(isRecord(o.data) && isRecord(o.data.imagedata) ? [{ id: o.data.imagedata.assetId, url: o.data.imagedata.url, alt: str(o.data.imagedata.altText) }] : [])];
        const { html, variable } = objectHtml(o);
        for (const p of pictures) {
          const urls = this.picture(p.id, p.url);
          // Storyline's own drawing of a shape (`txt__default_…`), and of any text in it: the text,
          // when the shape keeps it, is read; else what it shows is not.
          if (urls.some(u => /(^|\/)txt__default_/.test(u))) { if (!html) read.drawn = true; continue; }
          read.pictured = true;
          const url = urls.find(u => this.r.finds(u, this.root));
          if (url) read.html += imgHtml(url, FILE_NAME.test(p.alt.trim()) ? '' : p.alt.trim());
        }
        const text = html ? plainText(html) ?? '' : '';
        // Nothing but a running course's values; or, on a page, a copy of the text just read beside
        // it (a shadow, say). A question's choices and places may read the same.
        const last = read.pieces.at(-1);
        const copy = !questionSlide && last?.text === text && last.within.join() === within.join();
        if (!text.replace(/…/g, '').trim() || copy) continue;
        read.html += html;
        read.pieces.push({ id, kind, within, text, variable });
      }
    }
    return read;
  }
}

/** What a question's correct answer names: its choices (with how each is compared), its pairs, its comparisons. */
function namedBy(evaluate: unknown): { equals: Array<{ choice: string; ignorecase: boolean }>; pairs: Array<{ choice: string; statement: string }>; compares: Json[] } {
  const out = { equals: [] as Array<{ choice: string; ignorecase: boolean }>, pairs: [] as Array<{ choice: string; statement: string }>, compares: [] as Json[] };
  const strip = (ref: unknown): string => str(ref).replace(/^(?:choices|statements)\./, '');
  const walk = (v: unknown, depth: number): void => {
    if (depth > 12) return;
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
    if (!isRecord(v)) return;
    const kind = str(v.kind);
    if (kind === 'equals' && str(v.choiceid)) out.equals.push({ choice: strip(v.choiceid), ignorecase: v.ignorecase === true });
    else if (kind === 'pair') out.pairs.push({ choice: strip(v.choiceid), statement: strip(v.statementid) });
    else if (kind === 'compare') out.compares.push(v);
    walk(v.statements, depth + 1);
    walk(v.statement, depth + 1);
  };
  walk(evaluate, 0);
  return out;
}

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim();
/** Whether no two texts read the same, as a question here compares them (case and spacing aside). */
const distinct = (xs: string[]): boolean => new Set(xs.map(x => x.toLowerCase().replace(/\s+/g, ' '))).size === xs.length;

/** A question as Storyline grades it, kept on its topic, or why not, listed. */
function storylineQuestion(r: Reading, it: Json, slide: SlideRead, topic: ImportedTopic, where: string): void {
  const type = str(it.type);
  if (it.issurvey === true) { r.left(where, 'a survey question, which grades nothing'); return; }
  const correct = records(it.answers).find(a => str(a.status) === 'correct');
  if (!correct) { r.left(where, 'it marks no answer correct'); return; }
  if (type === 'hotspot') { r.left(where, 'a hotspot question, which a check here would not show'); return; }
  const named = namedBy(correct.evaluate);
  const choices = records(it.choices);
  const statements = records(it.statements);
  // A question built from a form names its choices; a free-form one's are objects on the slide.
  const freeform = /^FreeForm/i.test(str(it.lmsId));
  const objectOf = (c: Json): string => str(c.id).replace(/^(?:choice|statement)_/, '');
  const owned = new Set([...choices, ...statements].map(objectOf));
  const ownerOf = (p: Piece): string | undefined => [p.id, ...[...p.within].reverse()].find(id => owned.has(id));
  const textOf = (c: Json | undefined): string | null => {
    if (!c) return null;
    const own = oneLine(slide.pieces.filter(p => ownerOf(p) === objectOf(c)).map(p => p.text).join(' '));
    const formed = oneLine(plainText(esc(str(c.lmstext))) ?? '');
    return (freeform ? own : formed || own) || null;
  };
  const others = slide.pieces.filter(p => !ownerOf(p) && !FORM_PARTS.has(p.kind) && !p.variable && !COUNTER.test(p.text))
    .map(p => p.text).filter((t, i, all) => t !== all[i - 1]);
  const label = (plainText(esc(str(it.lmstext))) ?? '').trim();
  // Its own words when the slide shows them, with any longer text beside them (a passage it asks
  // about); else the slide's text. A label that is only a type's name ("Pick One") is no text here.
  const question = label && others.includes(label)
    ? others.filter(t => t === label || t.length > label.length).join('\n\n')
    : others.join('\n\n');
  if (!question.trim()) { r.left(where, slide.pictured ? 'its question is a picture or a video, which a check here would not show' : 'its question has no text'); return; }
  const byId = (id: string): Json | undefined => choices.find(c => str(c.id) === id) ?? statements.find(c => str(c.id) === id);

  switch (type) {
    case 'multiplechoice':
    case 'truefalse':
    case 'wordbank':
    case 'multipleresponse': {
      const options = choices.map(c => textOf(c));
      if (!options.length || options.some(o => !o)) { r.left(where, 'a choice is a picture, which a check here would not show'); return; }
      if (!distinct(options as string[])) { r.left(where, 'two of its choices read the same, so which is which is only where each is on the slide'); return; }
      const right = choices.flatMap((c, i) => (named.equals.some(e => e.choice === str(c.id)) ? [i] : []));
      if (!right.length) { r.left(where, 'it marks no answer correct'); return; }
      const shuffled = choices.some(c => slide.shuffled.has(objectOf(c)));
      const shown = shuffled ? turned(options as string[], right, question) : { options: options as string[], right };
      r.keep(topic, choice(question, shown.options, shown.right, type === 'multipleresponse'), where);
      return;
    }
    case 'fillin': {
      const accepted = named.equals.map(e => ({ text: (plainText(esc(str(byId(e.choice)?.lmstext))) ?? '').trim(), ignorecase: e.ignorecase })).filter(a => a.text);
      if (!accepted.length) { r.left(where, 'it gives no answer'); return; }
      const cases = new Set(accepted.map(a => a.ignorecase));
      if (cases.size > 1) { r.left(where, 'its answers differ in whether letter case counts, and a question here grades them one way'); return; }
      const [first, ...rest] = [...new Set(accepted.map(a => a.text))];
      r.keep(topic, { question, type: 'fill-in', answer: first!, ...(rest.length ? { accept: rest } : {}), ...(cases.has(false) ? { caseSensitive: true as const } : {}), compare: 'exact' }, where);
      return;
    }
    case 'matching': {
      const matched: Array<{ statement: string; choice: string }> = [];
      for (const p of named.pairs) {
        const statement = byId(p.statement);
        const item = byId(p.choice);
        if (!statement || !item) { r.left(where, 'a match names what the question does not hold'); return; }
        const [s, c] = [textOf(statement), textOf(item)];
        if (!s || !c) { r.left(where, 'a match is a picture, or a place on one, which a check here would not show'); return; }
        matched.push({ statement: s, choice: c });
      }
      if (!matched.length) { r.left(where, 'it marks no pairs correct'); return; }
      // Each item a learner places, and where it goes: several may go to one place (sorted into
      // groups), so the place is the answer. A drop-down asks of each statement which choice.
      const byStatement = matched.map(m => [m.statement, m.choice] as [string, string]);
      const byChoice = matched.map(m => [m.choice, m.statement] as [string, string]);
      const order = /DropDown/i.test(str(it.lmsId)) ? [byStatement, byChoice] : [byChoice, byStatement];
      const pairs = order.find(ps => distinct(ps.map(p => p[0])));
      if (!pairs) { r.left(where, 'its items and places both repeat, which a matching question here does not ask'); return; }
      const key = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ');
      const answers = new Set(pairs.map(p => key(p[1])));
      const spare = (pairs === byChoice ? statements : choices).map(c => textOf(c)).filter((t): t is string => !!t && !answers.has(key(t)));
      if (answers.size + new Set(spare.map(key)).size < 2) { r.left(where, 'its places read the same, so which is which is only where each is on the slide'); return; }
      r.keep(topic, { question, type: 'matching', pairs, ...(spare.length ? { distractors: [...new Set(spare)] } : {}) }, where);
      return;
    }
    case 'sequence': {
      const placed = named.pairs.map(p => ({ item: textOf(byId(p.choice)), at: numberOf(str(byId(p.statement)?.lmstext).trim()) }));
      if (!placed.length || placed.some(p => !p.item || !Number.isFinite(p.at))) { r.left(where, 'its order names what the question does not hold'); return; }
      r.keep(topic, { question, type: 'sequencing', items: placed.sort((a, b) => a.at - b.at).map(p => p.item!) }, where);
      return;
    }
    case 'numeric': {
      // Values any one of which is right; a bound (at least, between) is a range, not a value.
      const values = named.compares.map(c => (str(c.operator) === 'eq' ? numberOf(c.valueb) : Number.NaN));
      if (!values.length || values.some(v => !Number.isFinite(v))) { r.left(where, 'its right answer is a range or a comparison, not a value'); return; }
      const [first, ...rest] = [...new Set(values)];
      r.keep(topic, { question, type: 'numeric', answer: first!, ...(rest.length ? { accept: rest } : {}) }, where);
      return;
    }
    default:
      r.left(where, `a ${type || 'untyped'} question, which is not read`);
  }
}

/**
 * A package Storyline published, read in Storyline's own model: each scene a topic of its content
 * slides as pages and its questions, a bank a scene draws from asked whole. Null when the package
 * holds no Storyline course.
 */
export function storylinePackage(files: PackageFiles, opts: ToolReadOptions): ImportedPackage | null {
  const dataFile = files.names.filter(n => /(^|\/)html5\/data\/js\/data\.js$/.test(n)).sort((a, b) => a.length - b.length)[0];
  if (!dataFile) return null;
  const root = dataFile.slice(0, dataFile.length - 'html5/data/js/data.js'.length);
  const data = provided(new Reading(files, opts.fileUrl).text(dataFile), 'data');
  if (!data || !Array.isArray(data.scenes)) return null;
  const sl = new Storyline(files, opts.fileUrl, data, root);
  const { r } = sl;
  const frame = provided(r.text(`${root}html5/data/js/frame.js`), 'frame');

  const title = decodeEntities(/<project\b[^>]*\btitle="([^"]*)"/.exec(r.text(`${root}meta.xml`) ?? '')?.[1] ?? '').trim()
    || decodeEntities(/<title>([^<]*)<\/title>/i.exec(r.text(`${root}story.html`) ?? '')?.[1] ?? '').trim()
    || (isRecord(frame?.controlOptions) && isRecord(frame.controlOptions.sidebarOptions) ? oneLine(plainText(str(frame.controlOptions.sidebarOptions.titleText)) ?? '') : '')
    || opts.title?.trim() || 'Imported course';
  // A scene's title is only in the player's menu; a slide's notes, only in the frame.
  const sceneTitles = new Map<string, string>();
  const nav = isRecord(frame?.navData) && isRecord(frame.navData.outline) ? records(frame.navData.outline.links) : [];
  for (const link of nav) {
    const id = /^_player\.([^.]+)$/.exec(str(link.slideid))?.[1];
    const text = oneLine(plainText(str(link.displaytext)) ?? '');
    if (id && text && !/^untitled scene$/i.test(text)) sceneTitles.set(id, text);
  }
  const notes = new Map(records(frame?.notesData).map(n => [str(n.slideId), str(n.content)] as const));
  const bank = new Map(records(isRecord(data.slideBank) ? data.slideBank.slides : []).map(s => [str(s.id), s] as const));

  const scenes = records(data.scenes).filter(s => s.isMessageScene !== true);
  if (scenes.every(s => Number.isFinite(numberOf(s.sceneNumber)))) scenes.sort((a, b) => numberOf(a.sceneNumber) - numberOf(b.sceneNumber));
  const topics: ImportedTopic[] = [];
  let narrated = 0;
  scenes.forEach((scene, si) => {
    const sceneId = str(scene.id) || `scene-${si + 1}`;
    const sceneTitle = sceneTitles.get(sceneId) || (scenes.length === 1 ? title : `Scene ${si + 1}`);
    // Its slides and the banks it draws from, in the scene's order.
    const entries = [
      ...records(scene.slides).map(s => ({ slides: [s], n: numberOf(s.slideNumberInScene) })),
      ...records(scene.slidedraws).map(d => ({ slides: records(d.sliderefs).map(ref => bank.get(str(ref.id))).filter((s): s is Json => !!s), n: numberOf(d.slideNumberInScene) })),
    ].map((e, i) => ({ ...e, i }));
    if (entries.every(e => Number.isFinite(e.n))) entries.sort((a, b) => a.n - b.n || a.i - b.i);
    const chunked = entries.length >= SLIDES_PER_TOPIC * 2;
    let topic: ImportedTopic | null = null;
    entries.forEach((entry, k) => {
      if (!topic || (chunked && k % SLIDES_PER_TOPIC === 0)) {
        const last = Math.min(entries.length, k + SLIDES_PER_TOPIC);
        topic = chunked
          ? { id: `${sceneId}-${k + 1}`, title: `${sceneTitle}: slides ${k + 1} to ${last}`, pages: [], questions: [] }
          : { id: sceneId, title: sceneTitle, pages: [], questions: [] };
        topics.push(topic);
      }
      for (const s of entry.slides) {
        const slideId = str(s.id);
        const where = `${dataFile}#${sceneId}/${slideId}`;
        const html5url = str(s.html5url) || `html5/data/js/${slideId}.js`;
        const interactions = records(s.interactions);
        const read = sl.slide(html5url, interactions.length > 0);
        if (read.narrated) narrated++;
        for (const why of new Set(read.media)) r.left(where, why);
        if (interactions.length) {
          interactions.forEach((it, j) => storylineQuestion(r, it, read, topic!, interactions.length > 1 ? `${where}/${j + 1}` : where));
          continue;
        }
        if (read.results) { r.left(where, "a quiz's results slide: the score it shows is a running course's"); continue; }
        const note = notes.get(`${sceneId}.${slideId}`) ?? '';
        const html = read.html + (plainText(note)?.trim() ? `<h2>Notes</h2>${note}` : '');
        const own = oneLine(plainText(esc(str(s.title))) ?? '');
        const slideTitle = own && !/^untitled slide$/i.test(own) ? own : `Slide ${k + 1}`;
        const page = html.trim() ? r.page(esc(slideTitle), html, root) : { title: '', body: '' };
        if (page.body.trim()) topic!.pages.push({ path: `${root}${html5url}`, title: page.title || slideTitle, body: page.body });
        else if (read.drawn) r.left(where, 'what it shows is drawn as shapes, which are not read');
      }
    });
  });
  if (narrated) r.left(dataFile, `narration on ${narrated === 1 ? 'one slide' : `${narrated} slides`}, which is not text`);
  return { title, topics: topics.filter(t => t.pages.length || t.questions.length), unread: r.unread };
}
