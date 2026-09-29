/**
 * What every reader of an authoring tool's own model shares (tool-exports.ts, rise-course.ts,
 * storyline-course.ts, ispring-course.ts): how a package's files are found and served, how a page is
 * written from the HTML a tool keeps, how a question is kept only when it stands as an authored one
 * does, how options a tool shows shuffled are turned, and how a string or an object a tool's data
 * file writes as JavaScript is read without running it. Each reader reads its tool's model; this is what they
 * have in common.
 */
import { authorQuestion, QuestionError } from './course-questions.js';
import { plainText } from './question-banks.js';
import {
  fileUrlIn, htmlPage, markdownUrl, packageLookup, webUrl,
  type ImportedQuestion, type ImportedTopic, type LeftOut, type PackageFiles,
} from './package-import.js';

export type Json = Record<string, unknown>;
export const isRecord = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const records = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isRecord) : []);
export const numberOf = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN);
/** An option named by its letter, as an author names one (a one-letter text would be read as a letter). */
export const letter = (i: number): string => String.fromCharCode(65 + i);
/** Text as HTML says it: nothing in it read as markup. */
export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const BOM = String.fromCharCode(0xfeff);
export const SHOWS = 'shows an image, a formula or media, which a check here would not show';
export const WITH_MEDIA = 'its question comes with an image or a video, which a check here would not show';
export const joined = (...parts: string[]): string => parts.filter(p => p.trim()).join('\n\n');

export interface ToolReadOptions { fileUrl: (path: string) => string; title?: string }

/** One package being read: how its files are found and served, and what was left out. */
export class Reading {
  readonly unread: LeftOut[] = [];
  private found: ReturnType<typeof packageLookup> | null = null;

  constructor(private readonly files: PackageFiles, private readonly fileUrl: (path: string) => string) {}

  /** How a reference finds its file, made on first use: a reader that finds no course there needs none. */
  private get lookup(): ReturnType<typeof packageLookup> {
    return (this.found ??= packageLookup(this.files.names));
  }

  text(name: string): string | null {
    const bytes = this.files.read(name);
    if (!bytes) return null;
    const text = bytes.toString('utf8');
    return text.startsWith(BOM) ? text.slice(1) : text;
  }

  json(name: string): unknown {
    const text = this.text(name);
    if (text === null) return undefined;
    try { return JSON.parse(text); } catch { return undefined; }
  }

  /** Whether a reference, resolved in `folder` ('' or ending in /), is on the web or one of the package's files. */
  finds(ref: string, folder: string): boolean {
    return webUrl(ref) !== null || this.lookup.inPackage(ref, fileUrlIn(folder)) !== null;
  }

  /**
   * A page: its title (HTML) and its content (HTML), written as the Markdown a page shows
   * (package-import.ts writes it), its images and downloads the package's own files as this bridge
   * serves them, resolved in `folder` ('' or ending in /).
   */
  page(title: string, html: string, folder: string): { title: string; body: string } {
    const file = (ref: string): string | null => {
      const f = this.lookup.inPackage(ref, fileUrlIn(folder));
      return f ? markdownUrl(this.fileUrl(f)) : null;
    };
    // Heading the page with its own title keeps a first <h1> in the content in the body.
    const read = htmlPage(`<h1>${title}</h1>${html}`, { image: src => webUrl(src) ?? file(src), link: href => webUrl(href) ?? file(href) });
    return { title: read.title ?? '', body: read.body };
  }

  left(path: string, why: string): void {
    this.unread.push({ path, why });
  }

  /** A question kept on its topic when it stands as an authored one does (course-questions.ts); else why not, listed. */
  keep(topic: ImportedTopic, got: ImportedQuestion | string, where: string): void {
    let q: ImportedQuestion | string = got;
    if (typeof q !== 'string') {
      try { authorQuestion(q, 'package-import'); } catch (e) { if (e instanceof QuestionError) q = e.message; else throw e; }
    }
    if (typeof q === 'string') this.left(where, q);
    else topic.questions.push(q);
  }
}

/** Options the tool shows shuffled, turned by a count their question decides; and where the right ones went. */
export function turned(options: string[], right: number[], seed: string): { options: string[]; right: number[] } {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const n = options.length;
  const k = n ? h % n : 0;
  return { options: [...options.slice(k), ...options.slice(0, k)], right: right.map(i => (i - k + n) % n).sort((a, b) => a - b) };
}

/** A choice question: its options, the right ones by index, and one or several to pick. */
export function choice(question: string, options: string[], right: number[], multiple: boolean): ImportedQuestion {
  const several = multiple || right.length > 1;
  return { question, type: 'choice', options, answer: several ? right.map(letter) : letter(right[0]!), ...(several ? { multiple: true as const } : {}) };
}

/** What HTML shows that is no text: a picture or media. */
const MEDIA_TAG = /<(?:img|video|audio|object|embed|svg|math|canvas|iframe)\b/i;

/**
 * Whether HTML shows anything: its text, or a picture or media. `plainText` reads no media as
 * text (it answers null), so it is no test of whether a page is empty (Codex, on #583: an
 * interaction with a picture was left out whole).
 */
export function shows(html: string): boolean {
  return MEDIA_TAG.test(html) || !!plainText(html)?.trim();
}

/** A picture as HTML: its file and its alt text. */
export function imgHtml(src: string, alt: string): string {
  return src.trim() ? `<p><img src="${esc(src)}" alt="${esc(alt)}"></p>` : '';
}

const JS_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
/** A run of characters that neither close a literal quoted so nor start an escape. */
const PLAIN_RUN: Record<string, RegExp> = { "'": /[^'\\]*/y, '"': /[^"\\]*/y };

/**
 * A JavaScript string literal a tool's data file writes (single- or double-quoted, starting at
 * `at`), read as JavaScript reads it without running anything: its escapes decoded (\n, \xHH,
 * \uHHHH, a line continuation, any other character as itself). Null when it does not close. It
 * reads the literal once, however many escapes it holds: a data file can hold megabytes in one.
 */
export function jsStringAt(text: string, at: number): { value: string; end: number } | null {
  const q = text[at];
  if (q !== "'" && q !== '"') return null;
  const run = PLAIN_RUN[q]!;
  let out = '';
  let i = at + 1;
  for (;;) {
    run.lastIndex = i;
    // A run always matches, if only as nothing, except past the end (an escape cut short).
    if (!run.exec(text)) return null;
    const stop = run.lastIndex;
    out += text.slice(i, stop);
    if (stop >= text.length) return null;
    if (text[stop] === q) return { value: out, end: stop + 1 };
    const n = text[stop + 1] ?? '';
    if (n === 'u') { out += String.fromCharCode(parseInt(text.slice(stop + 2, stop + 6), 16)); i = stop + 6; }
    else if (n === 'x') { out += String.fromCharCode(parseInt(text.slice(stop + 2, stop + 4), 16)); i = stop + 4; }
    else if (n === '\r' || n === '\n') { i = stop + (n === '\r' && text[stop + 2] === '\n' ? 3 : 2); }
    else { out += JS_ESCAPES[n] ?? n; i = stop + 2; }
  }
}

/**
 * A JavaScript object literal a tool's data file writes (starting at `at`), read without running it
 * (Captivate's course; a Storyline data file that gives its JSON as an object): objects (keys bare
 * names, numbers or strings), arrays, strings, numbers, true, false, null, and a bare reference to
 * a runtime handler (`cp.fd`), kept as its name. A key given twice keeps its last value, as
 * JavaScript does. Null when what is there is not such a literal.
 */
export function literalAt(src: string, at: number): { value: unknown; end: number } | null {
  let i = at;
  class NotALiteral extends Error {}
  const fail = (): never => { throw new NotALiteral(); };
  const ws = (): void => {
    for (;;) {
      while (i < src.length && (src[i] === ' ' || src[i] === '\n' || src[i] === '\r' || src[i] === '\t')) i++;
      if (src.startsWith('//', i)) { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n; continue; }
      if (src.startsWith('/*', i)) { const n = src.indexOf('*/', i + 2); i = n < 0 ? src.length : n + 2; continue; }
      return;
    }
  };
  const name = (): string => {
    const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 256));
    if (!m) return fail();
    i += m[0].length;
    return m[0];
  };
  const number = (): string => {
    const m = /^[-+]?(?:0x[\da-f]+|(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/i.exec(src.slice(i, i + 64));
    if (!m) return fail();
    i += m[0].length;
    return m[0];
  };
  const text = (): string => {
    const s = jsStringAt(src, i);
    if (!s) return fail();
    i = s.end;
    return s.value;
  };
  const value = (depth: number): unknown => {
    if (depth > 256) fail();
    ws();
    const c = src[i];
    if (c === '{') {
      i++;
      const o: Record<string, unknown> = {};
      for (ws(); src[i] !== '}'; ws()) {
        if (i >= src.length) fail();
        const key = src[i] === "'" || src[i] === '"' ? text() : /[-\d.]/.test(src[i] ?? '') ? number() : name();
        ws();
        if (src[i] !== ':') fail();
        i++;
        o[key] = value(depth + 1);
        ws();
        if (src[i] === ',') i++;
        else if (src[i] !== '}') fail();
      }
      i++;
      return o;
    }
    if (c === '[') {
      i++;
      const a: unknown[] = [];
      for (ws(); src[i] !== ']'; ws()) {
        if (i >= src.length) fail();
        if (src[i] === ',') { a.push(null); i++; continue; }
        a.push(value(depth + 1));
        ws();
        if (src[i] === ',') i++;
        else if (src[i] !== ']') fail();
      }
      i++;
      return a;
    }
    if (c === "'" || c === '"') return text();
    if (c !== undefined && /[-+\d.]/.test(c)) return Number(number());
    const id = name();
    if (id === 'true') return true;
    if (id === 'false') return false;
    if (id === 'null' || id === 'undefined') return null;
    // A handler the runtime defines, by its name. A call, a function or `new` is no value: what
    // follows its name is neither a comma nor a close, and ends the read.
    let ref = id;
    while (src[i] === '.') { i++; ref += `.${name()}`; }
    return { ref };
  };
  try {
    const v = value(0);
    return { value: v, end: i };
  } catch (e) {
    if (e instanceof NotALiteral) return null;
    throw e;
  }
}
