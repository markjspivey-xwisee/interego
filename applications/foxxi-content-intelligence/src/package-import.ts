/**
 * A SCORM package read into Foxxi's content model, and folded into fragments and compositions: its
 * pages as teaching and the questions it declares as checks, in the order and the shape the
 * package gives them. What the fold makes resolves per learner, plays step by step, and learns
 * which alternative works once others are offered at a position, as a course authored here does
 * (course-fold.ts).
 *
 * ★ WHAT IS READ, AND IN WHAT ORDER. The manifest names the package's files: each organization
 * item's resource in the organization's order, its launch page first and then the files it lists,
 * then any resource no item names. Every HTML page among them is teaching, except those kept in
 * the folders packages keep their shared chrome in (course-graph.ts NONCONTENT).
 *
 * ★ A PAGE BECOMES MARKDOWN, as course-markdown.ts renders it: headings (one level down, under the
 * page's title), paragraphs, line breaks, lists, tables, quotes, preformatted text, emphasis, links
 * and images. Its first top-level heading is its title, else its <title>, else its file's name. An
 * image is the package's own file as this bridge hosts it; a link to another page of the package
 * keeps its text and not the link, since that page is a fragment of its own now. Scripts, styles,
 * form controls, media and embedded documents are not text a reader reads, and are left out.
 *
 * ★ PAGES ARE GROUPED AS THE PACKAGE GROUPS THEM. The pages in one top folder are one topic, titled
 * by the organization item whose launch page is there when exactly one item's is, else by the
 * folder's name; a page in no folder is a topic of its own. A topic of more than one part becomes
 * a composition: its pages in order, then its check.
 *
 * ★ QUESTIONS ARE READ ONLY AS THE PACKAGE DECLARES THEM. A package that grades itself in script
 * often keeps its questions as data: calls to a constructor it declares itself, such as
 * `function Question(id, text, type, answers, correctAnswer, objectiveId)`, its question types
 * named by constants it declares too. Where it does, each call in a topic's scripts is read by the
 * package's own parameter names and constants, and becomes a question written as an author writes
 * one (course-questions.ts): choice, true-false or numeric, graded on this bridge. The package
 * serves the same answers to every browser it runs in, as any package that grades itself does, so
 * a check folded from one is only as closed-book as the package was.
 *
 * ★ AND A BANK IN ANOTHER FORM IS READ AS ITS FORM DECLARES IT (question-banks.ts). Packages also
 * keep their questions in the standard's own form, QTI items (2.x, 3.0 and 1.2), and as plain
 * data: a JSON file, or an array of question objects written out in a script. Each is read wherever
 * the package keeps it, by what its form declares (a QTI item's correct response, a data bank's
 * field names), as choice, true-false, numeric, fill-in, sequencing or matching. A bank sits in its
 * folder's topic, a script's in the topic of the page that loads it, and one kept with the shared
 * chrome in a topic of its own.
 *
 * ★ NOTHING IS INVENTED, AND WHAT IS NOT READ IS SAID. A page with no text of its own (its script
 * draws what it shows), shared chrome, a question whose arguments are not written out as values or
 * whose answer does not fit it, a page longer than a fragment holds: each is left out and listed,
 * with why.
 */
import type AdmZip from 'adm-zip';
import { COMPOSITION_LIMITS, compositionFrom, type Composition } from './compositions.js';
import { competencyRef, ContentError, FRAGMENT_LIMITS, fragmentFrom, type Fragment } from './content-fragments.js';
import { fitted } from './course-fold.js';
import { humanize, NONCONTENT } from './course-graph.js';
import { authorQuestion, QuestionError } from './course-questions.js';
import type { CognitiveLevel } from './emergent-content.js';
import { dataQuestions, qtiQuestions, type BankRead } from './question-banks.js';
import { parseManifest, type ScormActivityTree } from './scorm-sequencing.js';

/**
 * What stops a package from folding that lies in the package (no manifest, nothing with text, too
 * large for one fold), as against what the caller named (a competency, a level, a language).
 */
export class PackageError extends ContentError {}

/** A package's files: their names as the zip has them, and each one's bytes. */
export interface PackageFiles {
  names: readonly string[];
  read(name: string): Buffer | null;
}

/** The files of a zip, its folders left out. */
export function filesOfZip(zip: AdmZip): PackageFiles {
  const entries = zip.getEntries().filter(e => !e.isDirectory);
  const byName = new Map(entries.map(e => [e.entryName, e]));
  return { names: entries.map(e => e.entryName), read: name => byName.get(name)?.getData() ?? null };
}

export interface ImportedPage { path: string; title: string; body: string }

/** A question as an author writes one (course-questions.ts), graded by what the package says is right. */
export type ImportedQuestion =
  | { question: string; type: 'choice'; options: string[]; answer: string | string[]; multiple?: true }
  | { question: string; type: 'true-false'; answer: boolean }
  | { question: string; type: 'numeric'; answer: number; accept?: number[]; min?: number; max?: number }
  | { question: string; type: 'fill-in'; answer: string; accept?: string[]; caseSensitive?: true; compare?: 'exact' | 'letters' }
  | { question: string; type: 'sequencing'; items: string[] }
  | { question: string; type: 'matching'; pairs: Array<[string, string]>; distractors?: string[] };

export interface ImportedTopic {
  /** The top folder its pages are in, or the path of a page in none. */
  id: string;
  title: string;
  pages: ImportedPage[];
  questions: ImportedQuestion[];
}

/** What was left out, and why. */
export interface LeftOut { path: string; why: string }

export interface ImportedPackage {
  title: string;
  topics: ImportedTopic[];
  unread: LeftOut[];
}

// ── Text ─────────────────────────────────────────────────────────────

const BOM = String.fromCharCode(0xfeff);
const REPLACEMENT = String.fromCharCode(0xfffd);

/** A script or a manifest as text: UTF-8, without a byte-order mark. */
function utf8(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/** The labels the web reads as windows-1252 (the Encoding Standard's list for that encoding). */
const WINDOWS_1252_LABELS = new Set(['ansi_x3.4-1968', 'ascii', 'cp1252', 'cp819', 'csisolatin1', 'ibm819', 'iso-8859-1', 'iso-ir-100', 'iso8859-1', 'iso88591', 'iso_8859-1', 'iso_8859-1:1987', 'l1', 'latin1', 'us-ascii', 'windows-1252', 'x-cp1252']);

/**
 * Bytes as windows-1252, decoded here rather than by TextDecoder: Node 20's TextDecoder reads that
 * label as ISO-8859-1, so 0x80 to 0x9F came out as control characters (CI, on #553).
 */
function windows1252(bytes: Buffer): string {
  return bytes.toString('latin1').replace(/[\x80-\x9f]/g, c => String.fromCharCode(C1[c.charCodeAt(0) - 0x80]!));
}

/** A page's bytes as text: in the charset it declares, else as UTF-8, else (not being UTF-8) as windows-1252. */
export function pageText(bytes: Buffer): string {
  const head = bytes.subarray(0, 4096).toString('latin1');
  const declared = /<meta\b[^>]*charset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)/i.exec(head)?.[1]
    ?? /^\s*<\?xml\b[^>]*encoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/i.exec(head)?.[1];
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const decode = (label: string, fatal: boolean): string | null => {
    if (WINDOWS_1252_LABELS.has(label.toLowerCase())) return windows1252(bytes);
    try { return new TextDecoder(label, { fatal }).decode(bytes); } catch { return null; }
  };
  const text = (hasBom ? decode('utf-8', false) : null)
    ?? (declared ? decode(declared, false) : null)
    ?? decode('utf-8', true)
    ?? windows1252(bytes);
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/** The named character references of HTML's Latin-1 range, U+00A0 to U+00FF, in order. */
const LATIN1_NAMES = 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml';
const ENTITIES = new Map<string, number>([
  ['quot', 34], ['amp', 38], ['apos', 39], ['lt', 60], ['gt', 62],
  ['OElig', 338], ['oelig', 339], ['Scaron', 352], ['scaron', 353], ['Yuml', 376], ['fnof', 402], ['circ', 710], ['tilde', 732],
  ['ensp', 8194], ['emsp', 8195], ['thinsp', 8201], ['zwnj', 8204], ['zwj', 8205], ['lrm', 8206], ['rlm', 8207],
  ['ndash', 8211], ['mdash', 8212], ['lsquo', 8216], ['rsquo', 8217], ['sbquo', 8218], ['ldquo', 8220], ['rdquo', 8221], ['bdquo', 8222],
  ['dagger', 8224], ['Dagger', 8225], ['bull', 8226], ['hellip', 8230], ['permil', 8240], ['prime', 8242], ['Prime', 8243],
  ['lsaquo', 8249], ['rsaquo', 8250], ['oline', 8254], ['euro', 8364], ['trade', 8482],
  ['larr', 8592], ['uarr', 8593], ['rarr', 8594], ['darr', 8595], ['harr', 8596],
  ['minus', 8722], ['infin', 8734], ['asymp', 8776], ['ne', 8800], ['le', 8804], ['ge', 8805],
  ...LATIN1_NAMES.split(' ').map((name, i): [string, number] => [name, 0xa0 + i]),
]);
/** What a numeric reference in 0x80 to 0x9F means in HTML: windows-1252's characters, as browsers read them. */
const C1 = [8364, 129, 8218, 402, 8222, 8230, 8224, 8225, 710, 8240, 352, 8249, 338, 141, 381, 143, 144, 8216, 8217, 8220, 8221, 8226, 8211, 8212, 732, 8482, 353, 8250, 339, 157, 382, 376];

/** Text with its character references decoded. One that names nothing is left as it is. */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (whole, dec?: string, hex?: string, name?: string) => {
    let cp = dec !== undefined ? Number(dec) : hex !== undefined ? parseInt(hex, 16) : ENTITIES.get(name!);
    if (cp === undefined) return whole;
    if (cp >= 0x80 && cp <= 0x9f) cp = C1[cp - 0x80]!;
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return REPLACEMENT;
    return String.fromCodePoint(cp);
  });
}

// ── HTML ─────────────────────────────────────────────────────────────

type Token =
  | { kind: 'open'; name: string; attrs: Map<string, string>; selfClosing: boolean }
  | { kind: 'close'; name: string }
  | { kind: 'text'; text: string }
  | { kind: 'raw'; name: string; attrs: Map<string, string>; text: string };

/** Elements whose content is not markup, read whole as text. */
const RAW = new Set(['script', 'style', 'title', 'textarea', 'xmp', 'noscript', 'template', 'iframe', 'noembed', 'noframes']);

function attributesOf(inner: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of inner.matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = m[1]!.toLowerCase();
    if (!attrs.has(name)) attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return attrs;
}

/** HTML as a flat run of tags and text, taken as forgivingly as a browser takes it. */
function htmlTokens(html: string): Token[] {
  const lower = html.toLowerCase();
  const out: Token[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out.push({ kind: 'text', text: html.slice(i) }); break; }
    if (lt > i) out.push({ kind: 'text', text: html.slice(i, lt) });
    if (html.startsWith('<!--', lt)) { const end = html.indexOf('-->', lt + 4); i = end < 0 ? html.length : end + 3; continue; }
    const tag = /^<(\/?)([A-Za-z][A-Za-z0-9:_-]*)/.exec(html.slice(lt, lt + 100));
    if (!tag) {
      if (html[lt + 1] === '!' || html[lt + 1] === '?') { const end = html.indexOf('>', lt); i = end < 0 ? html.length : end + 1; continue; }
      out.push({ kind: 'text', text: '<' });
      i = lt + 1;
      continue;
    }
    // The tag ends at the first `>` that is not inside a quoted attribute value.
    let j = lt + tag[0].length;
    while (j < html.length && html[j] !== '>') {
      if (html[j] === '=') {
        let k = j + 1;
        while (k < html.length && /\s/.test(html[k]!)) k++;
        const q = html[k];
        if (q === '"' || q === "'") { const end = html.indexOf(q, k + 1); j = end < 0 ? html.length : end + 1; continue; }
      }
      j++;
    }
    const inner = html.slice(lt + tag[0].length, j);
    i = Math.min(html.length, j + 1);
    const name = tag[2]!.toLowerCase().replace(/^[^:]*:/, '');
    if (tag[1]) { out.push({ kind: 'close', name }); continue; }
    const selfClosing = /\/\s*$/.test(inner);
    const attrs = attributesOf(inner);
    if (RAW.has(name) && !selfClosing) {
      const close = lower.indexOf(`</${name}`, i);
      out.push({ kind: 'raw', name, attrs, text: html.slice(i, close < 0 ? html.length : close) });
      const gt = close < 0 ? -1 : html.indexOf('>', close);
      i = gt < 0 ? html.length : gt + 1;
      continue;
    }
    out.push({ kind: 'open', name, attrs, selfClosing });
  }
  return out;
}

/** Elements whose content is not text a reader reads: skipped whole. */
const SKIP = new Set(['head', 'svg', 'math', 'object', 'applet', 'canvas', 'audio', 'video', 'select', 'button', 'map', 'datalist']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hgroup', 'hr', 'html', 'legend', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'ul',
]);
const INLINE_MARK: Record<string, 'strong' | 'em' | 'code' | undefined> = { strong: 'strong', b: 'strong', em: 'em', i: 'em', cite: 'em', code: 'code', tt: 'code', kbd: 'code', samp: 'code' };

/** A URL as a Markdown link or image target may hold it: no spaces or parentheses. */
export function markdownUrl(url: string): string {
  return url.replace(/[\s()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** An absolute http(s) URL, as a Markdown target, or null. */
export function webUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? markdownUrl(url.href) : null;
  } catch { return null; }
}

/**
 * A page's text as Markdown shows it as it is: each character inline syntax reads, escaped
 * (course-markdown.ts reads a backslash escape). `<p>*as written*</p>` is asterisks, not emphasis
 * (Codex, on #553). An underscore inside a word is no syntax, and is left as it is.
 */
function literal(text: string): string {
  return text.replace(/[\\`*[\]|]/g, c => `\\${c}`).replace(/(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, '\\_');
}

/** A line of a page's text as Markdown shows it as it is: a start block syntax reads, escaped. */
function literalStart(line: string): string {
  return line
    .replace(/^(\s*)(#{1,6}|[-+])(?=\s|$)/, '$1\\$2')
    .replace(/^(\s*)>/, '$1\\>')
    .replace(/^(\s*)-(?=(?:\s*-){2,}\s*$)/, '$1\\-')
    .replace(/^(\s*\d{1,9})([.)])(?=\s|$)/, '$1\\$2')
    .replace(/^(\s*)~~~/, '$1\\~~~');
}

/** Markdown's own markers taken out of a line, and its escapes read, for a title that is plain text. */
function plain(markdown: string): string {
  return markdown
    .replace(/!\[[^\]\n]*\]\([^)\s]*\)/g, '')
    .replace(/(?<!\\)\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
    .replace(/(?<!\\)(\*\*|\*|`)/g, '')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface HtmlPage {
  /** The first top-level heading, else the document's title. */
  title?: string;
  /** The page's text as Markdown, its title heading left out. */
  body: string;
  /** The page's own scripts (not those it loads), in order. */
  scripts: string[];
  /** Where the scripts it loads are, as written (`<script src>`), in order. */
  scriptSrcs: string[];
}

/**
 * A page as Markdown. `image` and `link` say where an image's source and a link's target lead, as
 * an absolute http(s) URL, or null to leave the image out or keep only the link's text; by default
 * only an absolute http(s) URL is kept.
 */
export function htmlPage(html: string, opts: { image?: (src: string) => string | null; link?: (href: string) => string | null } = {}): HtmlPage {
  const image = opts.image ?? webUrl;
  const link = opts.link ?? webUrl;
  const tokens = htmlTokens(html);
  let docTitle: string | undefined;
  const scripts: string[] = [];
  const scriptSrcs: string[] = [];
  for (const t of tokens) {
    if (t.kind !== 'raw') continue;
    if (t.name === 'title' && docTitle === undefined) docTitle = decodeEntities(t.text).replace(/\s+/g, ' ').trim() || undefined;
    if (t.name === 'script' && t.attrs.get('src')?.trim()) scriptSrcs.push(t.attrs.get('src')!.trim());
    else if (t.name === 'script' && t.text.trim()) scripts.push(t.text);
  }

  /** Each block, and for a list item the list it is in: items of one list are written together. */
  const blocks: Array<{ text: string; list: number }> = [];
  let listRun = 0;
  let title: string | undefined;
  let text = '';
  let heading = 0;
  let item: string | null = null;
  let quote = 0;
  const lists: Array<{ ordered: boolean; n: number }> = [];
  let marks: Array<{ name: string; at: number; href: string | null }> = [];
  let pre: string | null = null;
  let table: { rows: string[][]; row: string[] | null; cell: boolean } | null = null;
  let tables = 0;
  let skip: { name: string; depth: number } | null = null;

  const push = (block: string, isItem = false): void => {
    blocks.push({ text: quote ? block.split('\n').map(l => `${'> '.repeat(quote)}${l}`).join('\n') : block, list: isItem ? listRun : 0 });
  };
  const flush = (): void => {
    const t = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
    text = '';
    marks = [];
    if (!t) return;
    if (heading) {
      const words = t.replace(/\n/g, ' ');
      if (heading === 1 && title === undefined && plain(words)) { title = plain(words); return; }
      push(`${'#'.repeat(Math.max(1, heading - 1))} ${words}`);
      return;
    }
    if (item !== null) { push(`${item}${t.replace(/\n/g, '\n  ')}`, true); item = null; return; }
    push(t.split('\n').map(literalStart).join('\n'));
  };
  const inline = (s: string): void => {
    if (pre !== null) pre += s;
    else text += s;
  };
  const closeMark = (name: string): void => {
    const k = marks.map(m => m.name).lastIndexOf(name);
    if (k < 0) return;
    const m = marks[k]!;
    marks = marks.slice(0, k);
    const inner = text.slice(m.at);
    const body = inner.trim();
    if (!body || body.includes('\n')) return;
    const lead = inner.slice(0, inner.length - inner.trimStart().length);
    const trail = inner.slice(inner.trimEnd().length);
    let made: string | null = null;
    const asWritten = body.replace(/\\([!-/:-@[-`{-~])/g, '$1');
    if (name === 'strong' && !/(?<!\\)\*/.test(body)) made = `**${body}**`;
    else if (name === 'em' && !/(?<!\\)\*/.test(body)) made = `*${body}*`;
    else if (name === 'code' && !asWritten.includes('`')) made = `\`${asWritten}\``;
    else if (name === 'a' && m.href) {
      const words = body.replace(/(?<!\\)[*`]/g, '').replace(/(?<!\\)[[\]]/g, ' ').replace(/\s+/g, ' ').trim();
      if (words) made = `[${words}](${m.href})`;
    }
    if (made) text = text.slice(0, m.at) + lead + made + trail;
  };
  const endCell = (): void => {
    if (!table?.cell) return;
    (table.row ??= []).push(text.replace(/\s+/g, ' ').trim());
    text = '';
    marks = [];
    table.cell = false;
  };
  const endRow = (): void => {
    endCell();
    if (table?.row?.length) table.rows.push(table.row);
    if (table) table.row = null;
  };
  const endTable = (): void => {
    endRow();
    const rows = table?.rows ?? [];
    table = null;
    const width = Math.max(0, ...rows.map(r => r.length));
    // A table of one row or one column lays a page out; its cells are read as paragraphs.
    if (rows.length < 2 || width < 2) {
      for (const cell of rows.flat()) if (cell) push(literalStart(cell));
      return;
    }
    const line = (r: string[]): string => `| ${[...r, ...Array<string>(width - r.length).fill('')].join(' | ')} |`;
    push([line(rows[0]!), `| ${Array<string>(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n'));
  };

  const start = tokens.findIndex(t => t.kind === 'open' && t.name === 'body');
  for (const t of tokens.slice(start + 1)) {
    if (skip) {
      if (t.kind === 'open' && t.name === skip.name && !t.selfClosing) skip.depth++;
      else if (t.kind === 'close' && (t.name === skip.name || t.name === 'body' || t.name === 'html') && (t.name !== skip.name || --skip.depth === 0)) skip = null;
      continue;
    }
    if (t.kind === 'raw') continue;
    if (t.kind === 'text') {
      const s = decodeEntities(t.text);
      inline(pre !== null ? s : literal(s.replace(/\s+/g, ' ')));
      continue;
    }
    const { name } = t;
    if (t.kind === 'open' && SKIP.has(name) && !t.selfClosing) { skip = { name, depth: 1 }; continue; }
    if (pre !== null && name !== 'pre') { if (t.kind === 'open' && name === 'br') pre += '\n'; continue; }
    if (tables > 0 && name !== 'table' && name !== 'tr' && name !== 'td' && name !== 'th' && (BLOCK.has(name) || name === 'br')) { inline(' '); continue; }

    if (t.kind === 'open') {
      const mark = INLINE_MARK[name];
      if (mark) { marks.push({ name: mark, at: text.length, href: null }); continue; }
      switch (name) {
        case 'a': marks.push({ name: 'a', at: text.length, href: t.attrs.has('href') ? link(t.attrs.get('href')!) : null }); continue;
        case 'img': {
          const src = t.attrs.get('src');
          const url = src && !heading ? image(src) : null;
          if (url) inline(` ![${literal((t.attrs.get('alt') ?? '').replace(/\s+/g, ' ').trim())}](${url}) `);
          continue;
        }
        case 'br': inline(heading ? ' ' : '\n'); continue;
        case 'hr': flush(); push('---'); continue;
        case 'pre': flush(); pre = ''; continue;
        case 'table':
          if (tables++ === 0) { flush(); table = { rows: [], row: null, cell: false }; } else inline(' ');
          continue;
        case 'tr': if (tables === 1 && table) { endRow(); table.row = []; } else inline(' '); continue;
        case 'td': case 'th': if (tables === 1 && table) { endCell(); table.cell = true; text = ''; marks = []; } else inline(' '); continue;
        case 'ul': case 'ol': {
          flush();
          // A list inside another is written into it; one that starts afresh is a list of its own.
          if (!lists.length) listRun++;
          const from = Number.parseInt(t.attrs.get('start') ?? '1', 10);
          lists.push({ ordered: name === 'ol', n: name === 'ol' && Number.isFinite(from) ? Math.max(0, from - 1) : 0 });
          continue;
        }
        case 'li': {
          flush();
          const list = lists[lists.length - 1];
          item = list?.ordered ? `${++list.n}. ` : '- ';
          continue;
        }
        case 'blockquote': flush(); quote++; continue;
        case 'dt': flush(); marks.push({ name: 'strong', at: 0, href: null }); continue;
        default:
          if (/^h[1-6]$/.test(name)) { flush(); heading = Number(name[1]); continue; }
          if (BLOCK.has(name)) flush();
          continue;
      }
    }

    // A closing tag.
    const mark = INLINE_MARK[name];
    if (mark) { closeMark(mark); continue; }
    switch (name) {
      case 'a': closeMark('a'); continue;
      case 'pre': {
        const code = (pre ?? '').replace(/^\r?\n/, '').replace(/\s+$/, '');
        pre = null;
        if (code.trim()) { const fence = code.includes('```') ? '~~~' : '```'; push(`${fence}\n${code}\n${fence}`); }
        continue;
      }
      case 'table': if (tables > 0 && --tables === 0) endTable(); else if (tables > 0) inline(' '); continue;
      case 'tr': if (tables === 1) endRow(); continue;
      case 'td': case 'th': if (tables === 1) endCell(); continue;
      case 'ul': case 'ol': flush(); lists.pop(); continue;
      case 'li': flush(); item = null; continue;
      case 'blockquote': flush(); quote = Math.max(0, quote - 1); continue;
      case 'dt': closeMark('strong'); flush(); continue;
      default:
        if (/^h[1-6]$/.test(name)) { flush(); heading = 0; continue; }
        if (BLOCK.has(name)) flush();
        continue;
    }
  }
  if (table) endTable();
  if (pre !== null) { const code = pre.replace(/\s+$/, ''); pre = null; if (code.trim()) push(`\`\`\`\n${code}\n\`\`\``); }
  flush();

  let body = '';
  blocks.forEach((b, k) => { body += (k === 0 ? '' : b.list && b.list === blocks[k - 1]!.list ? '\n' : '\n\n') + b.text; });
  return { ...(title ?? docTitle ? { title: title ?? docTitle } : {}), body, scripts, scriptSrcs };
}

// ── Questions a package declares ─────────────────────────────────────

/** A value written out in a script. */
export type Literal =
  | { k: 'str'; v: string } | { k: 'num'; v: number } | { k: 'bool'; v: boolean } | { k: 'null' }
  | { k: 'id'; v: string } | { k: 'arr'; v: Literal[] } | { k: 'obj'; v: Array<[string, Literal]> };

/** Past whitespace and comments. */
function skipSpace(s: string, i: number): number {
  for (;;) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (s.startsWith('//', i)) { const nl = s.indexOf('\n', i); i = nl < 0 ? s.length : nl + 1; continue; }
    if (s.startsWith('/*', i)) { const end = s.indexOf('*/', i + 2); i = end < 0 ? s.length : end + 2; continue; }
    return i;
  }
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };

/** The string literal whose quote is at s[i], and where it ends; null when it does not end on its line. */
function readString(s: string, i: number): { value: string; end: number } | null {
  const q = s[i];
  let out = '';
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j]!;
    if (c === q) return { value: out, end: j + 1 };
    if (c === '\n') return null;
    if (c !== '\\') { out += c; continue; }
    const e = s[++j];
    if (e === undefined) return null;
    if (Object.prototype.hasOwnProperty.call(ESCAPES, e)) out += ESCAPES[e];
    else if (e === 'x' || (e === 'u' && s[j + 1] !== '{')) {
      const n = e === 'x' ? 2 : 4;
      const h = s.slice(j + 1, j + 1 + n);
      if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(h)) return null;
      out += String.fromCharCode(parseInt(h, 16));
      j += n;
    } else if (e === 'u') {
      const close = s.indexOf('}', j);
      const h = close < 0 ? '' : s.slice(j + 2, close);
      if (!/^[0-9a-fA-F]{1,6}$/.test(h) || parseInt(h, 16) > 0x10ffff) return null;
      out += String.fromCodePoint(parseInt(h, 16));
      j = close;
    } else if (e === '\r' || e === '\n') {
      if (e === '\r' && s[j + 1] === '\n') j++;
    } else out += e;
  }
  return null;
}

/** The value written at s[i] (strings joined with `+` are one), and where it ends; null for anything else. */
function readLiteral(s: string, i: number): { lit: Literal; end: number } | null {
  i = skipSpace(s, i);
  const c = s[i];
  if (c === '"' || c === "'") {
    const first = readString(s, i);
    if (!first) return null;
    let { value, end } = first;
    for (;;) {
      const plus = skipSpace(s, end);
      if (s[plus] !== '+') break;
      const next = skipSpace(s, plus + 1);
      if (s[next] !== '"' && s[next] !== "'") break;
      const more = readString(s, next);
      if (!more) return null;
      value += more.value;
      end = more.end;
    }
    return { lit: { k: 'str', v: value }, end };
  }
  const num = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/.exec(s.slice(i, i + 40));
  if (num) return { lit: { k: 'num', v: Number(num[0]) }, end: i + num[0].length };
  if (c === '[') { const list = readList(s, i + 1, ']'); return list && { lit: { k: 'arr', v: list.items }, end: list.end }; }
  if (c === '{') { const obj = readObject(s, i + 1); return obj && { lit: { k: 'obj', v: obj.fields }, end: obj.end }; }
  const word = /^[A-Za-z_$][\w$]*/.exec(s.slice(i, i + 200))?.[0];
  if (!word) return null;
  const end = i + word.length;
  if (word === 'true' || word === 'false') return { lit: { k: 'bool', v: word === 'true' }, end };
  if (word === 'null' || word === 'undefined') return { lit: { k: 'null' }, end };
  if (word === 'new') {
    const ctor = skipSpace(s, end);
    if (!/^Array\b/.test(s.slice(ctor, ctor + 6))) return null;
    const open = skipSpace(s, ctor + 5);
    if (s[open] !== '(') return null;
    const list = readList(s, open + 1, ')');
    return list && { lit: { k: 'arr', v: list.items }, end: list.end };
  }
  return { lit: { k: 'id', v: word }, end };
}

/** Values up to `closer`, separated by commas; null when any is not a value written out. */
function readList(s: string, i: number, closer: string): { items: Literal[]; end: number } | null {
  const items: Literal[] = [];
  let k = skipSpace(s, i);
  if (s[k] === closer) return { items, end: k + 1 };
  for (;;) {
    const lit = readLiteral(s, k);
    if (!lit) return null;
    items.push(lit.lit);
    k = skipSpace(s, lit.end);
    if (s[k] === ',') {
      k = skipSpace(s, k + 1);
      if (s[k] === closer) return { items, end: k + 1 };
      continue;
    }
    return s[k] === closer ? { items, end: k + 1 } : null;
  }
}

/**
 * Fields up to `}`: each named by a word, a string or a number, with a value written out; null for
 * anything else (a method, a spread, a computed name, a shorthand name whose value is elsewhere).
 */
function readObject(s: string, i: number): { fields: Array<[string, Literal]>; end: number } | null {
  const fields: Array<[string, Literal]> = [];
  let k = skipSpace(s, i);
  if (s[k] === '}') return { fields, end: k + 1 };
  for (;;) {
    let key: string;
    if (s[k] === '"' || s[k] === "'") {
      const str = readString(s, k);
      if (!str) return null;
      key = str.value;
      k = str.end;
    } else {
      const word = /^(?:[A-Za-z_$][\w$]*|\d+)/.exec(s.slice(k, k + 200))?.[0];
      if (!word) return null;
      key = word;
      k += word.length;
    }
    k = skipSpace(s, k);
    if (s[k] !== ':') return null;
    const value = readLiteral(s, k + 1);
    if (!value) return null;
    fields.push([key, value.lit]);
    k = skipSpace(s, value.end);
    if (s[k] === ',') {
      k = skipSpace(s, k + 1);
      if (s[k] === '}') return { fields, end: k + 1 };
      continue;
    }
    return s[k] === '}' ? { fields, end: k + 1 } : null;
  }
}

/** A literal as the value it writes; undefined for a name, whose value is not written there. */
function literalValue(lit: Literal): unknown {
  switch (lit.k) {
    case 'str': case 'num': case 'bool': return lit.v;
    case 'null': return null;
    case 'id': return undefined;
    case 'arr': return lit.v.map(literalValue);
    case 'obj': return Object.fromEntries(lit.v.map(([key, v]) => [key, literalValue(v)]));
  }
}

/**
 * The question banks a script writes out as data: each array of objects in its code that reads as
 * one (question-banks.ts), outermost first, so a bank's own lists of options are not read again as
 * banks of their own.
 */
export function literalBanks(script: string, path: string): BankRead[] {
  const out: BankRead[] = [];
  let past = 0;
  for (const m of codeOf(script).matchAll(/\[\s*\{/g)) {
    if (m.index! < past) continue;
    const read = readLiteral(script, m.index!);
    if (!read || read.lit.k !== 'arr') continue;
    const bank = dataQuestions(literalValue(read.lit), path);
    if (!bank) continue;
    out.push(bank);
    past = read.end;
  }
  return out;
}

/**
 * A script with its comments, and the insides of its strings, blanked to spaces, every character
 * where it was: what is left is code, so a call written in a comment or inside a string is not
 * taken for one that runs (Codex, on #553). A regular expression holding a quote may blank a little
 * code after it on its line, which can miss a call but never invents one.
 */
function codeOf(script: string): string {
  const out = script.split('');
  const blank = (from: number, to: number): void => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  for (let i = 0; i < script.length;) {
    const c = script[i]!;
    if (c === '/' && (script[i + 1] === '/' || script[i + 1] === '*')) {
      const end = script[i + 1] === '/' ? script.indexOf('\n', i) : script.indexOf('*/', i + 2);
      const to = end < 0 ? script.length : script[i + 1] === '/' ? end : end + 2;
      blank(i, to);
      i = to;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      for (; j < script.length && script[j] !== c; j++) {
        if (script[j] === '\\') j++;
        else if (c !== '`' && script[j] === '\n') break;
      }
      blank(i + 1, Math.min(j, script.length));
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** A page's own scripts, as written: the text of each <script> that loads none. */
function inlineScripts(html: string): string[] {
  return htmlTokens(html)
    .filter((t): t is Extract<Token, { kind: 'raw' }> => t.kind === 'raw' && t.name === 'script' && !t.attrs.get('src')?.trim() && !!t.text.trim())
    .map(t => t.text);
}

/** The arguments of each `new Question(…)` the script runs, in order: its values, or null for a call with any other argument. */
export function questionCalls(script: string): Array<Literal[] | null> {
  return [...codeOf(script).matchAll(/\bnew\s+Question\s*\(/g)].map(m => readList(script, m.index! + m[0].length, ')')?.items ?? null);
}

/** How a package declares its questions: its constructor's parameter names, and the constants it names things by. */
export interface QuestionForm { params: string[]; constants: ReadonlyMap<string, string> }

/** The question form the package's scripts declare, or null when none declares a Question constructor. */
export function questionForm(scripts: readonly string[]): QuestionForm | null {
  let params: string[] | null = null;
  const constants = new Map<string, string>();
  for (const s of scripts) {
    // Read from the code alone, so a declaration in a comment declares nothing; a constant's value
    // is read from the script itself, where the string still holds it.
    const code = codeOf(s);
    if (!params) {
      const m = /\bfunction\s+Question\s*\(([^)]*)\)/.exec(code) ?? /\bQuestion\s*=\s*function\s*\(([^)]*)\)/.exec(code);
      if (m) params = m[1]!.split(',').map(p => p.replace(/=[\s\S]*$/, '').trim()).filter(Boolean);
    }
    for (const c of code.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?=["'])/g)) {
      const value = readString(s, c.index! + c[0].length);
      if (value && !constants.has(c[1]!)) constants.set(c[1]!, value.value);
    }
  }
  return params ? { params, constants } : null;
}

type Role = 'text' | 'type' | 'options' | 'answer';
function roleOf(param: string): Role | null {
  const p = param.toLowerCase();
  if (/^(text|question|questiontext|prompt|stem)$/.test(p)) return 'text';
  if (/^(type|kind|questiontype)$/.test(p)) return 'type';
  if (/^(answers|choices|options|alternatives)$/.test(p)) return 'options';
  if (/^(correctanswer|correct|answer|key|correctresponse)$/.test(p)) return 'answer';
  return null;
}

/**
 * A call's values read as a question, by the package's own parameter names and constants: a
 * question written as an author writes one, or why it is not read.
 */
export function questionOf(args: readonly Literal[], form: QuestionForm): ImportedQuestion | string {
  const at = (role: Role): Literal | undefined => {
    const k = form.params.findIndex(p => roleOf(p) === role);
    return k < 0 ? undefined : args[k];
  };
  const text = at('text');
  const kind = at('type');
  const options = at('options');
  const answer = at('answer');
  if (text?.k !== 'str' || !text.v.trim()) return 'it has no question text written out';
  const typeName = kind?.k === 'str' ? kind.v : kind?.k === 'id' ? form.constants.get(kind.v) : undefined;
  if (typeName === undefined) return 'its type is not one the package names';
  const type = /^(choice|multiple-?choice|single-?choice)$/i.test(typeName) ? 'choice'
    : /^(true-?false|tf|boolean)$/i.test(typeName) ? 'true-false'
    : /^(numeric|number|integer)$/i.test(typeName) ? 'numeric' : null;
  if (!type) return `it is a "${typeName}" question, which is not read`;
  const question = text.v.trim();
  let read: ImportedQuestion;
  if (type === 'choice') {
    if (options?.k !== 'arr' || !options.v.length || options.v.some(o => o.k !== 'str')) return 'its options are not written out';
    const labels = options.v.map(o => (o as { v: string }).v);
    if (answer?.k !== 'str' || !labels.includes(answer.v)) return 'its answer is not one of its options';
    // Named by its letter: an option whose text is one letter ("A") would be read as a letter, and
    // could name another option than the one the package meant.
    read = { question, type, options: labels, answer: String.fromCharCode(65 + labels.indexOf(answer.v)) };
  } else if (type === 'true-false') {
    const said = answer?.k === 'bool' ? answer.v : answer?.k === 'str' && /^(true|false)$/i.test(answer.v.trim()) ? answer.v.trim().toLowerCase() === 'true' : undefined;
    if (said === undefined) return 'its answer is neither true nor false';
    read = { question, type, answer: said };
  } else {
    const n = answer?.k === 'num' ? answer.v : answer?.k === 'str' && answer.v.trim() ? Number(answer.v) : Number.NaN;
    if (!Number.isFinite(n)) return 'its answer is not a number';
    read = { question, type, answer: n };
  }
  // Written as an author writes it, it must stand as one does: its lengths, its options.
  try { authorQuestion(read, 'package-import'); }
  catch (e) { if (e instanceof QuestionError) return e.message; throw e; }
  return read;
}

// ── A package ────────────────────────────────────────────────────────

interface Resource { href: string | undefined; base: string; files: string[] }

/** The root a package's references resolve under; nothing outside it is the package's. */
const PACKAGE_ROOT = 'https://package.invalid/';

/** A base, resolved against the one it sits under, as xml:base resolves. */
function underBase(base: string, parent: string): string {
  if (!base.trim()) return parent;
  try { return new URL(base.trim(), parent).href; } catch { return parent; }
}

/**
 * The manifest's resources, in its order: each one's launch page, the base its references resolve
 * against, and the files it lists. The base is the resource's xml:base under the <resources>
 * element's, under the manifest's, as the content packaging model lets each level set one
 * (Codex, on #553).
 */
function resourcesOf(manifest: string): Map<string, Resource> {
  const manifestBase = attributesOf(/<(?:[\w-]+:)?manifest\b([^>]*)>/i.exec(manifest)?.[1] ?? '').get('xml:base') ?? '';
  const resourcesBase = attributesOf(/<(?:[\w-]+:)?resources\b([^>]*)>/i.exec(manifest)?.[1] ?? '').get('xml:base') ?? '';
  const inherited = underBase(resourcesBase, underBase(manifestBase, PACKAGE_ROOT));
  const out = new Map<string, Resource>();
  for (const m of manifest.matchAll(/<(?:[\w-]+:)?resource\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?resource\s*>)/gi)) {
    const attrs = attributesOf(m[1]!);
    const id = attrs.get('identifier');
    if (!id || out.has(id)) continue;
    const files = [...(m[2] ?? '').matchAll(/<(?:[\w-]+:)?file\b([^>]*?)\/?>/gi)]
      .map(f => attributesOf(f[1]!).get('href'))
      .filter((h): h is string => !!h);
    out.set(id, { href: attrs.get('href'), base: underBase(attrs.get('xml:base') ?? '', inherited), files });
  }
  return out;
}

/** Where a file (or, ending in /, a folder) of the package sits, as a URL its own references resolve against. */
export const fileUrlIn = (path: string): string => `${PACKAGE_ROOT}${path.split('/').map(encodeURIComponent).join('/')}`;

/**
 * How a package's names are looked up: `entryFor` names the file a path is, exactly or, when one
 * file matches that way, case-folded (packages made on case-insensitive disks often link with other
 * casing); `inPackage` names the file a reference is, resolved against `base` (a file's URL,
 * `fileUrlIn`, or a base folder's). A reference, or a base, that leads off the package names
 * nothing in it.
 */
export function packageLookup(names: readonly string[]): {
  entryFor: (path: string) => string | null;
  inPackage: (ref: string, base: string) => string | null;
} {
  const exact = new Set(names);
  const folded = new Map<string, string[]>();
  for (const n of names) folded.set(n.toLowerCase(), [...(folded.get(n.toLowerCase()) ?? []), n]);
  const entryFor = (path: string): string | null => {
    if (exact.has(path)) return path;
    const same = folded.get(path.toLowerCase());
    return same?.length === 1 ? same[0]! : null;
  };
  const inPackage = (ref: string, base: string): string | null => {
    const clean = ref.trim().split('#')[0]!.split('?')[0]!;
    if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) return null;
    try {
      const url = new URL(clean, base);
      if (`${url.origin}/` !== PACKAGE_ROOT) return null;
      let path = url.pathname.slice(1);
      try { path = decodeURIComponent(path); } catch { /* a name with a bare % */ }
      return entryFor(path);
    } catch { return null; }
  };
  return { entryFor, inPackage };
}

const PAGE = /\.(?:x?html?)$/i;
const SCRIPT = /\.m?js$/i;

/**
 * A package read: its title, its topics in the package's order (each its pages and the questions
 * it declares), and what was not read, with why. `fileUrl` says where this bridge serves a file of
 * the package, for an image or a download a page shows. Throws a ContentError when the package
 * has no manifest.
 */
export function readPackage(files: PackageFiles, opts: { fileUrl: (path: string) => string; title?: string }): ImportedPackage {
  const { entryFor, inPackage } = packageLookup(files.names);

  const manifestName = entryFor('imsmanifest.xml');
  const manifestBytes = manifestName ? files.read(manifestName) : null;
  if (!manifestBytes) throw new PackageError('the package has no imsmanifest.xml at its root');
  const manifest = utf8(manifestBytes);
  const resources = resourcesOf(manifest);
  let tree: ScormActivityTree | null = null;
  try { tree = parseManifest(manifest); } catch { tree = null; }
  const title = tree?.courseTitle?.trim() || opts.title?.trim() || 'Imported package';

  // The files in the order the package gives them, and the organization's title for each launch page.
  const ordered: string[] = [];
  const seen = new Set<string>();
  const launchTitle = new Map<string, string>();
  const add = (entry: string | null): void => { if (entry && !seen.has(entry)) { seen.add(entry); ordered.push(entry); } };
  const walk = (r: Resource | undefined, itemTitle?: string): void => {
    if (!r) return;
    const launch = r.href ? inPackage(r.href, r.base) : null;
    if (launch && itemTitle?.trim() && !launchTitle.has(launch)) launchTitle.set(launch, itemTitle.trim());
    add(launch);
    for (const f of r.files) add(inPackage(f, r.base));
  };
  for (const a of tree?.preorder ?? []) if (a.resourceId) walk(resources.get(a.resourceId), a.title);
  for (const r of resources.values()) walk(r);

  const topics = new Map<string, ImportedTopic & { folder: boolean }>();
  const topicFor = (entry: string): ImportedTopic & { folder: boolean } => {
    const slash = entry.indexOf('/');
    const id = slash < 0 ? entry : entry.slice(0, slash);
    let t = topics.get(id);
    if (!t) { t = { id, title: '', pages: [], questions: [], folder: slash >= 0 }; topics.set(id, t); }
    return t;
  };
  const unread: LeftOut[] = [];
  /** Scripts that may hold questions, each with the file whose topic its questions belong to. */
  const pageScripts: Array<{ path: string; text: string; topicOf: string }> = [];
  /** Script files that may hold questions, in the order met, and the first content page that loads each. */
  const scriptFiles: string[] = [];
  const loadedBy = new Map<string, string>();

  for (const entry of ordered) {
    if (NONCONTENT.test(entry)) {
      if (PAGE.test(entry)) unread.push({ path: entry, why: 'kept with the package\'s shared files: chrome, not a page of teaching' });
      continue;
    }
    if (SCRIPT.test(entry)) { if (!scriptFiles.includes(entry)) scriptFiles.push(entry); continue; }
    if (!PAGE.test(entry)) continue;
    const at = fileUrlIn(entry);
    const page = htmlPage(pageText(files.read(entry) ?? Buffer.alloc(0)), {
      image: src => webUrl(src) ?? (() => { const f = inPackage(src, at); return f ? markdownUrl(opts.fileUrl(f)) : null; })(),
      // Another page of the package is a fragment of its own now: its link keeps only its text.
      link: href => webUrl(href) ?? (() => { const f = inPackage(href, at); return f && !PAGE.test(f) ? markdownUrl(opts.fileUrl(f)) : null; })(),
    });
    for (const text of page.scripts) pageScripts.push({ path: entry, text, topicOf: entry });
    // A script a page loads is that page's, wherever it is kept, js/ included (Codex, on #553).
    for (const src of page.scriptSrcs) {
      const f = inPackage(src, at);
      if (!f || !SCRIPT.test(f)) continue;
      if (!loadedBy.has(f)) loadedBy.set(f, entry);
      if (!scriptFiles.includes(f)) scriptFiles.push(f);
    }
    if (!page.body.trim()) { unread.push({ path: entry, why: 'no text of its own: what it shows, its script draws' }); continue; }
    topicFor(entry).pages.push({ path: entry, title: page.title ?? launchTitle.get(entry) ?? humanize(entry), body: page.body });
  }
  // A script no page loads (a template may read it by name) belongs to its own folder's topic.
  for (const f of scriptFiles) pageScripts.push({ path: f, text: utf8(files.read(f) ?? Buffer.alloc(0)), topicOf: loadedBy.get(f) ?? f });

  // Questions, read as the package declares them. The declaration may be anywhere in the package,
  // in a script or in a page's own.
  const declared: string[] = [];
  for (const name of files.names) {
    if (SCRIPT.test(name)) declared.push(utf8(files.read(name) ?? Buffer.alloc(0)));
    else if (PAGE.test(name)) declared.push(...inlineScripts(pageText(files.read(name) ?? Buffer.alloc(0))));
  }
  const form = questionForm(declared);
  for (const { path, text, topicOf } of pageScripts) {
    const calls = questionCalls(text);
    if (!calls.length) continue;
    if (!form) { unread.push({ path, why: 'its questions call a constructor the package does not declare, so which value is which cannot be read' }); continue; }
    calls.forEach((args, i) => {
      const q = args ? questionOf(args, form) : 'its values are not all written out';
      if (typeof q === 'string') unread.push({ path, why: `question ${i + 1}: ${q}` });
      else topicFor(topicOf).questions.push(q);
    });
  }

  // Question banks in other forms (question-banks.ts): QTI items, and plain data in a JSON file or
  // written out in a script. Read wherever the package keeps them, in its order; a bank kept with
  // the shared chrome is a topic of its own, named by its file, rather than one called "Assets".
  const bankTopic = (entry: string): ImportedTopic => topicFor(NONCONTENT.test(entry) ? entry.slice(entry.lastIndexOf('/') + 1) : entry);
  for (const name of [...ordered, ...files.names.filter(n => !seen.has(n))]) {
    if (name === manifestName) continue;
    let read: BankRead | null = null;
    if (/\.xml$/i.test(name)) read = qtiQuestions(utf8(files.read(name) ?? Buffer.alloc(0)), name);
    else if (/\.json$/i.test(name)) {
      try { read = dataQuestions(JSON.parse(utf8(files.read(name) ?? Buffer.alloc(0))), name); } catch { read = null; }
    }
    if (!read) continue;
    bankTopic(name).questions.push(...read.questions);
    unread.push(...read.unread);
  }
  for (const { path, text, topicOf } of pageScripts) {
    for (const read of literalBanks(text, path)) {
      bankTopic(topicOf).questions.push(...read.questions);
      unread.push(...read.unread);
    }
  }

  // A folder is titled as the one organization item whose launch page is in it, else by its name.
  const itemTitles = new Map<string, Set<string>>();
  for (const [entry, t] of launchTitle) {
    const slash = entry.indexOf('/');
    const id = slash < 0 ? entry : entry.slice(0, slash);
    itemTitles.set(id, (itemTitles.get(id) ?? new Set()).add(t));
  }
  const out: ImportedTopic[] = [];
  for (const t of topics.values()) {
    if (!t.pages.length && !t.questions.length) continue;
    const named = itemTitles.get(t.id);
    const title = named?.size === 1 ? [...named][0]! : t.folder ? humanize(t.id) : t.pages[0]?.title ?? humanize(t.id);
    out.push({ id: t.id, title, pages: t.pages, questions: t.questions });
  }
  return { title, topics: out, unread };
}

// ── The fold ─────────────────────────────────────────────────────────

/** How many fragments one package folds into at most. */
export const PACKAGE_FOLD_LIMITS = { fragments: 500 } as const;

export interface PackageFoldOptions {
  /** The competency the package develops: an IRI, another authority's term IRI, or a slug. */
  competency: string;
  /** A topic's own competency, by topic id, where it differs from the package's. */
  topicCompetencies?: Readonly<Record<string, string>>;
  level?: CognitiveLevel;
  /** BCP 47 tag of the package's language. */
  language?: string;
  /** The blinding value for a topic's check (64 hex characters); a random one when this answers undefined. */
  blindFor?: (topicId: string) => string | undefined;
}

export interface FoldedTopic {
  id: string;
  title: string;
  competency: string;
  /** The IRI at the topic's position: its composition, or its one fragment. Absent when nothing in it folded. */
  at?: string;
  pages: Array<{ path: string; title: string; concept: string }>;
  check?: string;
  questions: number;
}

export interface FoldedPackage {
  root: Composition;
  /** Every fragment and composition the fold made, the root last; each once. */
  items: Array<Fragment | Composition>;
  topics: FoldedTopic[];
  /** What was read but not folded, and why. */
  left: LeftOut[];
}

/**
 * A package read, folded: each page a concept fragment, each topic's questions a check, each topic
 * of more than one part a composition of them in order, and the package a composition of its
 * topics. Throws a PackageError when nothing folds or the package is larger than one fold, and a
 * ContentError when what the caller named (competency, level, language) is not one.
 */
export function foldPackage(pkg: ImportedPackage, opts: PackageFoldOptions): FoldedPackage {
  const common = { level: opts.level ?? 'working', ...(opts.language ? { language: opts.language } : {}) };
  const packageCompetency = competencyRef(opts.competency, 'the competency of the package');
  // What the caller named is checked before any page is, so a bad level is the caller's to fix and
  // not a reason every page was left out.
  fragmentFrom({ kind: 'concept', ...common, competencies: [packageCompetency], body: 'what the caller named' });
  const made = pkg.topics.reduce((n, t) => n + t.pages.length + (t.questions.length ? 1 : 0), 0);
  if (made > PACKAGE_FOLD_LIMITS.fragments) throw new PackageError(`the package has ${made} pages and checks to fold; one fold makes at most ${PACKAGE_FOLD_LIMITS.fragments} fragments`);
  if (pkg.topics.length > COMPOSITION_LIMITS.positions) throw new PackageError(`the package has ${pkg.topics.length} topics; a composition has at most ${COMPOSITION_LIMITS.positions} positions`);
  const items = new Map<string, Fragment | Composition>();
  const keep = <T extends Fragment | Composition>(item: T): T => { items.set(item['@id'], item); return item; };
  const titleMax = Math.min(FRAGMENT_LIMITS.title, COMPOSITION_LIMITS.title);
  const left: LeftOut[] = [];

  const topics: FoldedTopic[] = pkg.topics.map(topic => {
    const own = opts.topicCompetencies && Object.prototype.hasOwnProperty.call(opts.topicCompetencies, topic.id);
    const competency = own ? competencyRef(opts.topicCompetencies![topic.id], `topic ${topic.id}'s competency`) : packageCompetency;
    const title = fitted(topic.title || topic.id, titleMax);
    const pages: FoldedTopic['pages'] = [];
    for (const page of topic.pages) {
      if (page.body.length > FRAGMENT_LIMITS.body) {
        left.push({ path: page.path, why: `longer than a fragment holds: ${page.body.length} characters of text, at most ${FRAGMENT_LIMITS.body}` });
        continue;
      }
      try {
        const concept = keep(fragmentFrom({ kind: 'concept', ...common, competencies: [competency], title: fitted(page.title, titleMax), body: page.body }));
        pages.push({ path: page.path, title: concept.title ?? page.title, concept: concept['@id'] });
      } catch (e) {
        if (!(e instanceof ContentError)) throw e;
        left.push({ path: page.path, why: e.message });
      }
    }
    const asked = topic.questions.slice(0, FRAGMENT_LIMITS.questions);
    if (topic.questions.length > asked.length) {
      left.push({ path: topic.id, why: `a check holds at most ${FRAGMENT_LIMITS.questions} questions; the other ${topic.questions.length - asked.length} were not folded` });
    }
    const blind = opts.blindFor?.(topic.id);
    let check: Fragment | undefined;
    if (asked.length) {
      try {
        check = keep(fragmentFrom({
          kind: 'assessment-item', ...common, competencies: [competency], title, body: `## ${title}`, questions: asked, ...(blind ? { blind } : {}),
        }));
      } catch (e) {
        if (!(e instanceof ContentError)) throw e;
        left.push({ path: topic.id, why: `its check: ${e.message}` });
      }
    }
    const parts = [...pages.map(p => p.concept), ...(check ? [check['@id']] : [])];
    const base = { id: topic.id, title, competency, pages, ...(check ? { check: check['@id'] } : {}), questions: check ? asked.length : 0 };
    if (!parts.length) return base;
    if (parts.length > COMPOSITION_LIMITS.positions) throw new PackageError(`topic ${topic.id} has ${parts.length} parts; a composition has at most ${COMPOSITION_LIMITS.positions}`);
    const at = parts.length === 1 ? parts[0]! : keep(compositionFrom({ title, competency, positions: parts.map(iri => ({ competency, paradigm: [iri] })) }))['@id'];
    return { ...base, at };
  });

  const placed = topics.filter(t => t.at);
  if (!placed.length) throw new PackageError('nothing in the package folds: no page has text of its own, and no question could be read');
  const root = compositionFrom({
    title: fitted(pkg.title, COMPOSITION_LIMITS.title), competency: packageCompetency,
    positions: placed.map(t => ({ competency: t.competency, paradigm: [t.at!] })),
  });
  items.delete(root['@id']);
  return { root, items: [...items.values(), root], topics, left };
}
