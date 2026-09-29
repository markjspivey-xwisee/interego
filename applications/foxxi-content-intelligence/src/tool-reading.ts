/**
 * What every reader of an authoring tool's own model shares (tool-exports.ts, rise-course.ts,
 * storyline-course.ts, ispring-course.ts): how a package's files are found and served, how a page is
 * written from the HTML a tool keeps, how a question is kept only when it stands as an authored one
 * does, how options a tool shows shuffled are turned, and how a string a tool's data file writes as
 * JavaScript is read without running it. Each reader reads its tool's model; this is what they
 * have in common.
 */
import { authorQuestion, QuestionError } from './course-questions.js';
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
  private readonly lookup: ReturnType<typeof packageLookup>;

  constructor(private readonly files: PackageFiles, private readonly fileUrl: (path: string) => string) {
    this.lookup = packageLookup(files.names);
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
