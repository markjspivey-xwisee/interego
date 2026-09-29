/**
 * Question banks a package keeps in forms other than calls to a constructor it declares (those,
 * package-import.ts reads): the standard's own form, IMS QTI (2.x and 3.0 assessment items, and
 * 1.2 items), and plain data (a JSON file, or an array of question objects written out in a
 * script, which package-import.ts finds and hands here as values).
 *
 * ★ READ AS THE FORM DECLARES IT, AND NOTHING INVENTED. A QTI item declares its correct response;
 * a data bank names its fields. What the form does not say is not guessed: an item with no correct
 * response, an interaction this bridge does not grade, a question that shows an image a check here
 * would not show, an answer given as a bare number when nothing says whether options count from 0
 * or from 1. Each is left out, and why is listed.
 *
 * ★ EACH IS WRITTEN AS AN AUTHOR WRITES A QUESTION (course-questions.ts): choice (one right option,
 * or several), true-false, numeric, fill-in (with the other answers it accepts), sequencing or
 * matching; and it must stand as an authored one does, so its lengths and options are checked the
 * same way before it is kept.
 *
 * ★ QTI 2 AND QTI 3 ARE ONE READING. QTI 3 renamed every element and attribute (`choiceInteraction`
 * became `qti-choice-interaction`, `responseIdentifier` became `response-identifier`), keeping what
 * each means. Names are read without the prefix, the hyphens or the case, so one reader takes both.
 */
import { authorQuestion, QuestionError } from './course-questions.js';
import type { ImportedQuestion, LeftOut } from './package-import.js';

/** What one file's bank gave: the questions read, and what was left out, with why. */
export interface BankRead { questions: ImportedQuestion[]; unread: LeftOut[] }

/** Written as an author writes it, a question must stand as one does; else why not. */
function standing(q: ImportedQuestion): ImportedQuestion | string {
  try { authorQuestion(q, 'package-import'); return q; }
  catch (e) { if (e instanceof QuestionError) return e.message; throw e; }
}

const MEDIA = /<(?:img|video|audio|object|embed|svg|math|canvas)\b/i;

// ── XML, as an ordered tree ─────────────────────────────────────────

interface XNode { name: string; attrs: Map<string, string>; kids: Array<XNode | string> }

/** A name as QTI 2 (`choiceInteraction`) and QTI 3 (`qti-choice-interaction`) both spell it. */
const norm = (name: string): string => name.slice(name.indexOf(':') + 1).replace(/^qti-/i, '').replace(/-/g, '').toLowerCase();

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e.startsWith('#')) {
      const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

/**
 * An XML document as a tree that keeps its text where it sits among its elements, which a stem
 * like "The capital is <textEntryInteraction/>." needs. Null when no element is read.
 */
function xmlTree(xml: string): XNode | null {
  const root: XNode = { name: '#document', attrs: new Map(), kids: [] };
  const stack: XNode[] = [root];
  const token = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const m of xml.matchAll(token)) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.kids.push(m[1]);
    else if (m[2] !== undefined) {
      // The nearest open element of that name closes; a close tag with none open is ignored.
      const name = norm(m[2]);
      for (let k = stack.length - 1; k > 0; k--) if (stack[k]!.name === name) { stack.length = k; break; }
    } else if (m[3] !== undefined) {
      const attrs = new Map<string, string>();
      for (const a of (m[4] ?? '').matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs.set(norm(a[1]!), decode(a[2] ?? a[3] ?? ''));
      const node: XNode = { name: norm(m[3]), attrs, kids: [] };
      top.kids.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.kids.push(decode(m[6]));
  }
  return root.kids.some(k => typeof k !== 'string') ? root : null;
}

const elementsOf = (n: XNode): XNode[] => n.kids.filter((k): k is XNode => typeof k !== 'string');
const childOf = (n: XNode, name: string): XNode | undefined => elementsOf(n).find(e => e.name === name);
const childrenOf = (n: XNode, name: string): XNode[] => elementsOf(n).filter(e => e.name === name);
function descendantsOf(n: XNode, pick: (e: XNode) => boolean, skip?: (e: XNode) => boolean, into: XNode[] = []): XNode[] {
  for (const e of elementsOf(n)) {
    if (skip?.(e)) continue;
    if (pick(e)) into.push(e);
    descendantsOf(e, pick, skip, into);
  }
  return into;
}

const BLOCKS = new Set(['p', 'div', 'br', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'tr', 'blockquote', 'pre', 'hr', 'prompt']);
/** Not text a question shows: feedback, rubrics, templates and the like. */
const NOT_SHOWN = new Set(['modalfeedback', 'feedbackblock', 'feedbackinline', 'rubricblock', 'templateblock', 'templateinline', 'printedvariable', 'stylesheet']);
const MEDIA_ELEMENTS = new Set(['img', 'object', 'math', 'video', 'audio', 'embed', 'svg', 'matimage', 'mataudio', 'matvideo', 'matapplet']);

/** Text as a reader reads it: blocks on lines of their own, whitespace collapsed; `gap` stands in for an element it names. */
function textOf(n: XNode, gap?: (e: XNode) => string | null): string {
  let out = '';
  const walk = (x: XNode): void => {
    for (const k of x.kids) {
      if (typeof k === 'string') { out += k; continue; }
      const stands = gap?.(k);
      if (stands !== null && stands !== undefined) { out += stands; continue; }
      if (NOT_SHOWN.has(k.name)) continue;
      const block = BLOCKS.has(k.name);
      if (block) out += '\n';
      walk(k);
      if (block) out += '\n';
    }
  };
  walk(n);
  return out.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

const showsMedia = (n: XNode, skip?: (e: XNode) => boolean): boolean => descendantsOf(n, e => MEDIA_ELEMENTS.has(e.name), skip).length > 0;
const unique = (xs: readonly string[]): string[] => [...new Set(xs)];
/**
 * An option named by its letter, as an author names one: a text of one letter ("a", "B") would be
 * read as a letter too, and name another option, so the right ones are named by place.
 */
const letter = (i: number): string => String.fromCharCode(65 + i);

// ── QTI 2.x and 3.0 ─────────────────────────────────────────────────

function noCorrect(decl: XNode | undefined): string {
  if (!decl) return 'it declares no response to grade';
  return childOf(decl, 'mapping') ? 'it is scored by a mapping and declares no correct response' : 'it declares no correct response';
}

/** An assessment item as a question, or why it is not read. */
function qti2Item(item: XNode): ImportedQuestion | string {
  const body = childOf(item, 'itembody');
  if (!body) return 'it has no item body';
  const interactions = descendantsOf(body, e => e.name.endsWith('interaction'));
  if (!interactions.length) return 'it asks nothing: it has no interaction';
  if (interactions.length > 1) return `it has ${interactions.length} interactions, and a question here asks one thing`;
  const ix = interactions[0]!;
  if (showsMedia(body, e => e === ix)) return 'its question shows an image, a formula or media, which a check here would not show';
  const decl = childrenOf(item, 'responsedeclaration').find(d => d.attrs.get('identifier') === ix.attrs.get('responseidentifier'));
  const correct = decl ? childrenOf(childOf(decl, 'correctresponse') ?? { name: '', attrs: new Map(), kids: [] }, 'value').map(v => textOf(v)) : [];
  const inline = ix.name === 'textentryinteraction' || ix.name === 'inlinechoiceinteraction';
  const lead = textOf(body, e => (e === ix ? (inline ? '____' : '') : null));
  const prompt = childOf(ix, 'prompt');
  const question = [lead, prompt ? textOf(prompt) : ''].filter(Boolean).join('\n\n');
  if (!question) return 'its question has no text';

  switch (ix.name) {
    case 'choiceinteraction':
    case 'inlinechoiceinteraction': {
      const choices = descendantsOf(ix, e => e.name === 'simplechoice' || e.name === 'inlinechoice');
      if (choices.some(c => showsMedia(c))) return 'an option shows an image or a formula, which a check here would not show';
      const options = choices.map(c => textOf(c));
      if (!correct.length) return noCorrect(decl);
      const at = correct.map(id => choices.findIndex(c => (c.attrs.get('identifier') ?? '') === id.trim()));
      if (at.some(i => i < 0)) return 'its correct response names an option it does not have';
      const answers = at.map(letter);
      const multiple = decl?.attrs.get('cardinality') === 'multiple';
      return { question, type: 'choice', options, answer: multiple || answers.length > 1 ? answers : answers[0]!, ...(multiple ? { multiple: true as const } : {}) };
    }
    case 'textentryinteraction': {
      if (!correct.length) return noCorrect(decl);
      const base = decl?.attrs.get('basetype');
      if (base === 'float' || base === 'integer') {
        const n = Number(correct[0]!.trim());
        return Number.isFinite(n) ? { question, type: 'numeric', answer: n } : 'its correct response is not a number';
      }
      // Other answers the item's mapping scores above nothing are accepted beside the correct one.
      const mapped = descendantsOf(decl ?? body, e => e.name === 'mapentry')
        .filter(e => Number(e.attrs.get('mappedvalue')) > 0).map(e => e.attrs.get('mapkey') ?? '').filter(Boolean);
      const [answer, ...rest] = unique(correct.map(c => c.trim()).filter(Boolean));
      if (!answer) return noCorrect(decl);
      const accept = unique([...rest, ...mapped.map(m => m.trim())]).filter(a => a && a !== answer);
      return { question, type: 'fill-in', answer, ...(accept.length ? { accept } : {}) };
    }
    case 'orderinteraction': {
      const choices = childrenOf(ix, 'simplechoice');
      if (choices.some(c => showsMedia(c))) return 'an item shows an image or a formula, which a check here would not show';
      if (!correct.length) return noCorrect(decl);
      const byId = new Map(choices.map(c => [c.attrs.get('identifier') ?? '', textOf(c)] as const));
      const items = correct.map(id => byId.get(id.trim()));
      if (items.some(i => i === undefined) || new Set(correct).size !== choices.length) return 'its correct order does not name each of its items once';
      return { question, type: 'sequencing', items: items as string[] };
    }
    case 'matchinteraction': {
      const sets = childrenOf(ix, 'simplematchset');
      if (sets.length !== 2) return 'it does not have the two sets a match has';
      const [from, to] = sets.map(s => childrenOf(s, 'simpleassociablechoice')) as [XNode[], XNode[]];
      if ([...from, ...to].some(c => showsMedia(c))) return 'a choice shows an image or a formula, which a check here would not show';
      if (!correct.length) return noCorrect(decl);
      const fromText = new Map(from.map(c => [c.attrs.get('identifier') ?? '', textOf(c)] as const));
      const toText = new Map(to.map(c => [c.attrs.get('identifier') ?? '', textOf(c)] as const));
      const pairs: Array<[string, string]> = [];
      const usedFrom = new Set<string>();
      const usedTo = new Set<string>();
      for (const v of correct) {
        const [a, b] = v.trim().split(/\s+/);
        const prompt = fromText.get(a ?? ''), target = toText.get(b ?? '');
        if (prompt === undefined || target === undefined) return 'a pair in its correct response names a choice it does not have';
        if (usedFrom.has(a!)) return 'an item matches more than one answer, which a matching question here does not ask';
        usedFrom.add(a!);
        usedTo.add(b!);
        pairs.push([prompt, target]);
      }
      if (usedFrom.size !== from.length) return 'not every item has its match';
      const distractors = to.filter(c => !usedTo.has(c.attrs.get('identifier') ?? '')).map(c => textOf(c));
      return { question, type: 'matching', pairs, ...(distractors.length ? { distractors } : {}) };
    }
    case 'extendedtextinteraction':
      return 'it asks for an extended answer, which is recorded rather than graded, so it is left for a reflection written here';
    default:
      return `it is a ${ix.name.replace(/interaction$/, '')} interaction, which this does not read`;
  }
}

// ── QTI 1.2 ─────────────────────────────────────────────────────────

/** A 1.2 item's text in `n`, outside `except`: its mattext, as HTML when it says so, as text; null when it shows media. */
function matText(n: XNode, except?: XNode): string | null {
  const texts = descendantsOf(n, e => e.name === 'mattext', e => e === except).map(m => textOf(m));
  if (texts.some(t => MEDIA.test(t))) return null;
  return texts.map(t => t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

/** The values a positive-scoring condition sets for `ident`: each varequal it tests, outside a `not`. */
function qti12Correct(item: XNode, ident: string | undefined): string[] {
  const out: string[] = [];
  for (const rc of descendantsOf(item, e => e.name === 'respcondition')) {
    const score = childrenOf(rc, 'setvar').reduce((sum, sv) => {
      const action = (sv.attrs.get('action') ?? 'Set').toLowerCase();
      const n = Number(textOf(sv));
      return (action === 'set' || action === 'add') && Number.isFinite(n) ? sum + n : sum;
    }, 0);
    if (score <= 0) continue;
    const cond = childOf(rc, 'conditionvar');
    if (!cond) continue;
    for (const v of descendantsOf(cond, e => e.name === 'varequal', e => e.name === 'not')) {
      const r = v.attrs.get('respident');
      if (!r || !ident || r === ident) out.push(textOf(v));
    }
  }
  return unique(out.map(v => v.trim()).filter(Boolean));
}

/** A 1.2 item as a question, or why it is not read. */
function qti12Item(item: XNode): ImportedQuestion | string {
  const pres = descendantsOf(item, e => e.name === 'presentation')[0];
  if (!pres) return 'it has no presentation';
  const responses = descendantsOf(pres, e => /^response_(lid|str|num|xy|grp)$/.test(e.name));
  if (!responses.length) return 'it asks nothing: it has no response';
  if (responses.length > 1) return `it has ${responses.length} responses, and a question here asks one thing`;
  const r = responses[0]!;
  if (showsMedia(pres, e => e === r)) return 'its question shows an image or media, which a check here would not show';
  const question = matText(pres, r);
  if (question === null) return 'its question shows an image, a formula or media, which a check here would not show';
  if (!question) return 'its question has no text';
  const correct = qti12Correct(item, r.attrs.get('ident'));
  if (!correct.length) return 'no condition that scores it names a correct response';
  if (r.name === 'response_lid') {
    const labels = descendantsOf(r, e => e.name === 'responselabel' || e.name === 'response_label');
    const labelTexts = labels.map(l => matText(l));
    if (labels.some(l => showsMedia(l)) || labelTexts.some(t => t === null)) return 'an option shows an image or media, which a check here would not show';
    const options = labelTexts as string[];
    const at = correct.map(id => labels.findIndex(l => (l.attrs.get('ident') ?? '') === id));
    if (at.some(i => i < 0)) return 'its correct response names an option it does not have';
    const answers = at.map(letter);
    const multiple = (r.attrs.get('rcardinality') ?? '').toLowerCase() === 'multiple';
    return { question, type: 'choice', options, answer: multiple || answers.length > 1 ? answers : answers[0]!, ...(multiple ? { multiple: true as const } : {}) };
  }
  if (r.name === 'response_str') {
    const [answer, ...accept] = correct;
    return { question, type: 'fill-in', answer: answer!, ...(accept.length ? { accept } : {}) };
  }
  if (r.name === 'response_num') {
    const n = Number(correct[0]);
    return Number.isFinite(n) ? { question, type: 'numeric', answer: n } : 'its correct response is not a number';
  }
  return `it is a ${r.name.replace(/^response_/, '')} response, which this does not read`;
}

const itemLabel = (item: XNode, i: number): string => {
  const id = item.attrs.get('identifier') ?? item.attrs.get('ident');
  return id ? `item "${id}"` : `item ${i + 1}`;
};

/**
 * The questions a QTI file holds, each item read as a question or listed with why not; null when
 * the file is not QTI items (a test that only refers to its items holds none of its own).
 */
export function qtiQuestions(xml: string, path: string): BankRead | null {
  if (!/<(?:[\w.-]+:)?(?:qti-)?(?:assessment-?item|questestinterop)\b/i.test(xml)) return null;
  const doc = xmlTree(xml);
  if (!doc) return null;
  const items2 = descendantsOf(doc, e => e.name === 'assessmentitem');
  const items12 = descendantsOf(doc, e => e.name === 'questestinterop').flatMap(q => descendantsOf(q, e => e.name === 'item'));
  if (!items2.length && !items12.length) return null;
  const read: BankRead = { questions: [], unread: [] };
  const take = (got: ImportedQuestion | string, label: string): void => {
    const q = typeof got === 'string' ? got : standing(got);
    if (typeof q === 'string') read.unread.push({ path, why: `${label}: ${q}` });
    else read.questions.push(q);
  };
  items2.forEach((item, i) => take(qti2Item(item), itemLabel(item, i)));
  items12.forEach((item, i) => take(qti12Item(item), itemLabel(item, i)));
  return read;
}

// ── Plain data ──────────────────────────────────────────────────────

type Kind = 'choice' | 'choice-multiple' | 'true-false' | 'numeric' | 'fill-in' | 'sequencing' | 'matching' | 'open';
const KINDS: Record<string, Kind> = {
  choice: 'choice', 'multiple-choice': 'choice', multiplechoice: 'choice', multichoice: 'choice', mcq: 'choice', mc: 'choice', 'single-choice': 'choice', singlechoice: 'choice', single: 'choice', radio: 'choice',
  'multiple-response': 'choice-multiple', multipleresponse: 'choice-multiple', 'multi-select': 'choice-multiple', multiselect: 'choice-multiple', 'multiple-answer': 'choice-multiple', checkbox: 'choice-multiple', checkboxes: 'choice-multiple', mr: 'choice-multiple',
  'true-false': 'true-false', truefalse: 'true-false', tf: 'true-false', boolean: 'true-false',
  numeric: 'numeric', number: 'numeric', integer: 'numeric',
  'fill-in': 'fill-in', fillin: 'fill-in', 'fill-in-the-blank': 'fill-in', blank: 'fill-in', text: 'fill-in', 'short-answer': 'fill-in', shortanswer: 'fill-in', input: 'fill-in',
  sequencing: 'sequencing', sequence: 'sequencing', order: 'sequencing', ordering: 'sequencing', sort: 'sequencing',
  matching: 'matching', match: 'matching', pairs: 'matching',
  essay: 'open', 'long-answer': 'open', 'long-fill-in': 'open', 'free-text': 'open', freetext: 'open', open: 'open', likert: 'open', survey: 'open',
};

const TEXT_KEYS = ['question', 'prompt', 'stem', 'questiontext', 'text'];
const STRONG_TEXT_KEYS = ['question', 'prompt', 'stem', 'questiontext'];
const OPTION_KEYS = ['options', 'choices', 'answers', 'responses', 'alternatives'];
const ANSWER_KEYS = ['answer', 'correct', 'correctanswer', 'correctanswers', 'correctresponse', 'solution', 'key'];
const INDEX_KEYS = ['correctindex', 'answerindex', 'correctindexes', 'correctindices'];
const FLAG_KEYS = ['correct', 'iscorrect', 'right', 'isright'];
const OPTION_TEXT_KEYS = ['text', 'label', 'value', 'answer', 'option', 'content', 'title'];
const TYPE_KEYS = ['type', 'kind', 'questiontype'];
const ACCEPT_KEYS = ['accept', 'accepted', 'acceptable', 'alsoaccept'];

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** A record's fields by their names without case, hyphens or underscores. */
const keyed = (o: Record<string, unknown>): Map<string, unknown> => new Map(Object.entries(o).map(([k, v]) => [k.toLowerCase().replace(/[_-]/g, ''), v]));
const pick = (m: Map<string, unknown>, keys: readonly string[]): [string, unknown] | undefined => {
  for (const k of keys) { const v = m.get(k); if (v !== undefined && v !== null) return [k, v]; }
  return undefined;
};

function looksLikeQuestion(v: unknown): boolean {
  if (!isRecord(v)) return false;
  const m = keyed(v);
  if (STRONG_TEXT_KEYS.some(k => typeof m.get(k) === 'string')) return true;
  return typeof m.get('text') === 'string' && (pick(m, ANSWER_KEYS) !== undefined || Array.isArray(pick(m, OPTION_KEYS)?.[1]));
}

/**
 * The lists a value keeps its questions in, in the order written: itself, or arrays a few levels
 * down (a quiz of sections, each with its questions). A list reads as a bank when at least half its
 * entries read as questions; a bank is not searched again inside.
 */
function banksIn(value: unknown, depth = 0, into: unknown[][] = []): unknown[][] {
  if (depth > 5) return into;
  if (Array.isArray(value)) {
    const questions = value.filter(looksLikeQuestion).length;
    if (questions > 0 && questions * 2 >= value.length) { into.push(value); return into; }
    for (const v of value) banksIn(v, depth + 1, into);
  } else if (isRecord(value)) for (const v of Object.values(value)) banksIn(v, depth + 1, into);
  return into;
}

/** Text a bank may keep as HTML: its tags dropped and its references decoded; null when it shows media. */
function plain(s: string): string | null {
  if (MEDIA.test(s)) return null;
  // A block's tags break the line; an inline one (<em>, <b>, <span>) leaves its words where they were.
  return decode(s.replace(/<(?:br|\/?(?:p|div|li|ul|ol|h[1-6]|tr|table|blockquote))\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ''))
    .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

/** One entry of a data bank as a question, or why it is not read. */
function dataQuestion(v: unknown): ImportedQuestion | string {
  if (!isRecord(v)) return 'it is not a question written as an object';
  const m = keyed(v);
  const rawText = pick(m, TEXT_KEYS)?.[1];
  const question = typeof rawText === 'string' ? plain(rawText) : '';
  if (question === null) return 'its question shows an image, a formula or media, which a check here would not show';
  if (!question) return 'it has no question text';
  const typeName = pick(m, TYPE_KEYS)?.[1];
  const kind = typeof typeName === 'string' ? KINDS[typeName.trim().toLowerCase().replace(/[\s_]+/g, '-')] : undefined;
  if (typeof typeName === 'string' && !kind) return `it is a "${typeName}" question, which is not read`;
  if (kind === 'open') return 'it asks for an answer that is recorded rather than graded, so it is left for a reflection written here';
  if (kind === 'sequencing' || kind === 'matching') return `a ${kind} question kept as data is not read; the standard's form of one (QTI) is`;

  const options = pick(m, OPTION_KEYS)?.[1];
  if (Array.isArray(options) && kind !== 'fill-in' && kind !== 'numeric' && kind !== 'true-false') {
    const texts: string[] = [];
    const flagged: number[] = [];
    for (const o of options) {
      let t: unknown = o;
      if (isRecord(o)) {
        const om = keyed(o);
        t = pick(om, OPTION_TEXT_KEYS)?.[1];
        const flag = pick(om, FLAG_KEYS)?.[1];
        if (typeof t === 'string' || typeof t === 'number') {
          const text = typeof t === 'string' ? plain(t) : String(t);
          if (text === null) return 'an option shows an image or media, which a check here would not show';
          if (flag === true || flag === 'true') flagged.push(texts.length);
          texts.push(text);
          continue;
        }
      }
      if (typeof t === 'string' || typeof t === 'number') {
        const text = typeof t === 'string' ? plain(t) : String(t);
        if (text === null) return 'an option shows an image or media, which a check here would not show';
        texts.push(text);
      } else return 'an option has no text';
    }
    let answers: string[];
    if (flagged.length) answers = flagged.map(letter);
    else {
      if (pick(m, INDEX_KEYS)) return 'its answer is an index, and whether that counts the options from 0 or from 1 is not said';
      const said = pick(m, ANSWER_KEYS)?.[1];
      if (said === undefined) return 'it names no correct option';
      const list = Array.isArray(said) ? said : [said];
      if (list.some(x => typeof x === 'number')) return 'its answer is a number, and whether that counts the options from 0 or from 1 is not said';
      const named: Array<string | null> = list.map(x => {
        if (typeof x !== 'string') return null;
        const t = plain(x) ?? '';
        if (texts.includes(t)) return letter(texts.indexOf(t));
        // A single capital letter names an option by its place, as an author writes "B".
        return /^[A-Z]$/.test(t) && t.charCodeAt(0) - 65 < texts.length ? t : null;
      });
      if (!named.length || named.some(n => n === null)) return 'its answer is not one of its options';
      answers = named as string[];
    }
    const multiple = kind === 'choice-multiple';
    return { question, type: 'choice', options: texts, answer: multiple || answers.length > 1 ? answers : answers[0]!, ...(multiple ? { multiple: true as const } : {}) };
  }

  const said = pick(m, ANSWER_KEYS)?.[1];
  if (said === undefined) return 'it gives no answer';
  if (kind === 'true-false' || typeof said === 'boolean') {
    const b = typeof said === 'boolean' ? said : /^(true|false)$/i.test(String(said).trim()) ? String(said).trim().toLowerCase() === 'true' : undefined;
    return b === undefined ? 'its answer is neither true nor false' : { question, type: 'true-false', answer: b };
  }
  if (kind === 'numeric' || (kind === undefined && typeof said === 'number')) {
    const n = typeof said === 'number' ? said : Number(String(said).trim());
    return Number.isFinite(n) ? { question, type: 'numeric', answer: n } : 'its answer is not a number';
  }
  const answersIn = (Array.isArray(said) ? said : [said]).filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean);
  if (!answersIn.length) return 'its answer is not written as text, a number, or true or false';
  const acceptIn = pick(m, ACCEPT_KEYS)?.[1];
  const accept = unique([...answersIn.slice(1), ...(Array.isArray(acceptIn) ? acceptIn : acceptIn === undefined ? [] : [acceptIn])
    .filter((x): x is string | number => typeof x === 'string' || typeof x === 'number').map(x => String(x).trim()).filter(Boolean)])
    .filter(a => a !== answersIn[0]);
  return { question, type: 'fill-in', answer: answersIn[0]!, ...(accept.length ? { accept } : {}) };
}

/**
 * The questions a value holds when it is a question bank, as data: an array of question objects,
 * or one kept a few records down. Each is read by its fields' names or listed with why not; null
 * when the value is not a bank.
 */
export function dataQuestions(value: unknown, path: string): BankRead | null {
  const lists = banksIn(value);
  if (!lists.length) return null;
  const read: BankRead = { questions: [], unread: [] };
  lists.flat().forEach((entry, i) => {
    const got = dataQuestion(entry);
    const q = typeof got === 'string' ? got : standing(got);
    if (typeof q === 'string') read.unread.push({ path, why: `question ${i + 1}: ${q}` });
    else read.questions.push(q);
  });
  return read;
}
