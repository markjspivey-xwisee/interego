/**
 * A relay-signed payload can carry `client_id` (the OAuth client the relay's session was issued
 * to, see `handleSignRequest` in deploy/mcp-relay/server.ts), and every closed list of the relay's
 * own transport fields in this repo has to say so.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 *
 * Several verticals verify a relay-signed request and then refuse any top-level field they do not
 * list, or strip the relay's fields before handing the rest to a closed schema. Each of those lists
 * named exactly the fields the relay set before: `agent_id`, `timestamp`, `subject_pod_url`. A
 * fourth field from the relay turned every one of them into a refusal of every chat agent's
 * request ("Unsupported payload fields", "undeclared fields", "invalid capture setting:
 * client_id", ...), with nothing wrong in the request.
 *
 * ── WHAT IT CHECKS, EXACTLY ──────────────────────────────────────────────────
 *
 * It reads every tracked JavaScript or TypeScript source file outside tests and build output (all
 * roots: applications, deploy, packages, integrations, examples, mcp-server, demos, tools, ...)
 * that names `subject_pod_url`, lexes it (comments, strings in any of the three quote styles,
 * template literals, regular expressions), and requires:
 *
 *   - LISTS: an array literal, or an argument list, whose own string elements include
 *     `agent_id`, `timestamp` and `subject_pod_url` also includes `client_id`. That covers
 *     `[...]`, `new Set([...])` and `exact(body, [...])` in single, double or backtick quotes, on
 *     one line or across many;
 *   - DESTRUCTURINGS: an object pattern that names `subject_pod_url` (shorthand, renamed or quoted)
 *     before a rest element, as a declaration, an assignment or a function's parameter, also names
 *     `client_id`.
 *
 *   - PROSE: a sentence in tracked documentation or source text that says what the relay adds to
 *     a signed payload ("the relay adds / supplies / stamps", "relay-added", "automatically
 *     stamped") and names `subject_pod_url` or the pod stamp mentions `client_id` in that sentence
 *     or the next. CHANGELOG.md is history and is not read.
 *
 * What it does NOT see: a list assembled from pieces (a spread of another array, a conditional
 * element), a chain of `k === '...'` comparisons, an object used as a lookup table, source in
 * other languages, and prose worded some other way. It also requires that it found the sites it
 * was written against, and that it understood every file it read (balanced brackets), so a rename
 * or a lexer slip cannot leave it checking nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── The lexer ────────────────────────────────────────────────────────────────

interface StringToken { readonly value: string; readonly start: number; readonly end: number }
interface Pair { readonly open: number; readonly close: number; readonly char: '[' | '(' | '{'; readonly strings: StringToken[]; readonly children: Pair[] }
interface Lexed { readonly masked: string; readonly pairs: Pair[]; readonly unbalanced: string | null }

const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'yield', 'await', 'else', 'do']);

/**
 * Comments become spaces and string bodies underscores (newlines kept, so offsets and line numbers
 * hold), every string literal is recorded with its value, and every bracket pair is recorded with
 * the string literals and pairs directly inside it. A template literal's `${...}` is code; its
 * text is not a string token unless it has no substitution.
 */
function lex(text: string): Lexed {
  const out = text.split('');
  const blank = (from: number, to: number, fill: string): void => {
    for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = fill;
  };
  const pairs: Pair[] = [];
  const stack: Array<{ char: '[' | '(' | '{'; open: number; strings: StringToken[]; children: Pair[] }> = [];
  const templateBraces: number[] = [];
  let braceDepth = 0;
  let unbalanced: string | null = null;
  let lastSignificant = '';
  let lastWord = '';
  const at = (i: number): string => `offset ${i}, line ${text.slice(0, i).split('\n').length}`;

  const readQuoted = (i: number, quote: string): number => {
    let j = i + 1;
    while (j < text.length && text.charAt(j) !== quote && text.charAt(j) !== '\n') j += text.charAt(j) === '\\' ? 2 : 1;
    return Math.min(j, text.length - 1);
  };
  /** From inside a template's text, to its closing backtick (returns that index) or a `${` (returns -(index+1)). */
  const readTemplate = (j: number): number => {
    while (j < text.length) {
      if (text.charAt(j) === '\\') { j += 2; continue; }
      if (text.charAt(j) === '`') return j;
      if (text.charAt(j) === '$' && text.charAt(j + 1) === '{') return -(j + 1);
      j++;
    }
    return text.length - 1;
  };

  let i = 0;
  const templateText = (from: number, withSubstitution: boolean): void => {
    // `from` is the first character of template text (after the backtick or after a `}`).
    const end = readTemplate(from);
    if (end >= 0) {
      blank(from, end, '_');
      if (!withSubstitution && stack.length) stack[stack.length - 1]!.strings.push({ value: text.slice(from, end), start: from - 1, end: end + 1 });
      i = end + 1;
      lastSignificant = '`'; lastWord = '';
    } else {
      const dollar = -end - 1;
      blank(from, dollar, '_');
      templateBraces.push(braceDepth);
      braceDepth++;
      i = dollar + 2;
      lastSignificant = '{'; lastWord = '';
    }
  };

  while (i < text.length) {
    const c = text.charAt(i);
    const n = text.charAt(i + 1);
    if (c === '/' && n === '/') { const e = text.indexOf('\n', i); const end = e < 0 ? text.length : e; blank(i, end, ' '); i = end; continue; }
    if (c === '/' && n === '*') { const e = text.indexOf('*/', i + 2); const end = e < 0 ? text.length : e + 2; blank(i, end, ' '); i = end; continue; }
    if (c === '/' && (lastSignificant === '' || REGEX_AFTER.has(lastSignificant) || REGEX_AFTER_WORD.has(lastWord))) {
      let j = i + 1; let inClass = false;
      while (j < text.length && text.charAt(j) !== '\n' && (inClass || text.charAt(j) !== '/')) {
        if (text.charAt(j) === '\\') j++;
        else if (text.charAt(j) === '[') inClass = true;
        else if (text.charAt(j) === ']') inClass = false;
        j++;
      }
      if (j < text.length && text.charAt(j) === '/') {
        blank(i + 1, j, '_');
        j++;
        while (j < text.length && /[a-z]/i.test(text.charAt(j))) j++;
        i = j; lastSignificant = ')'; lastWord = '';
        continue;
      }
    }
    if (c === "'" || c === '"') {
      const end = readQuoted(i, c);
      if (stack.length) stack[stack.length - 1]!.strings.push({ value: text.slice(i + 1, end), start: i, end: end + 1 });
      blank(i + 1, end, '_');
      i = end + 1; lastSignificant = c; lastWord = '';
      continue;
    }
    if (c === '`') {
      const end = readTemplate(i + 1);
      templateText(i + 1, end < 0);
      continue;
    }
    if (c === '}' && templateBraces.length && templateBraces.at(-1) === braceDepth - 1) {
      templateBraces.pop();
      braceDepth--;
      templateText(i + 1, true);
      continue;
    }
    if (c === '[' || c === '(' || c === '{') {
      if (c === '{') braceDepth++;
      stack.push({ char: c, open: i, strings: [], children: [] });
    } else if (c === ']' || c === ')' || c === '}') {
      if (c === '}') braceDepth--;
      const want = c === ']' ? '[' : c === ')' ? '(' : '{';
      const top = stack.pop();
      if (!top || top.char !== want) { unbalanced ??= `${c} at ${at(i)} closes ${top ? `${top.char} from ${at(top.open)}` : 'nothing'}`; if (top) stack.push(top); }
      else {
        const pair: Pair = { open: top.open, close: i, char: top.char, strings: top.strings, children: top.children };
        pairs.push(pair);
        if (stack.length) stack[stack.length - 1]!.children.push(pair);
      }
    }
    if (!/\s/.test(c)) {
      lastSignificant = c;
      if (/[\w$]/.test(c)) {
        let j = i; while (j < text.length && /[\w$]/.test(text.charAt(j))) j++;
        lastWord = text.slice(i, j);
        lastSignificant = 'w';
        i = j; continue;
      }
      lastWord = '';
    }
    i++;
  }
  if (stack.length) unbalanced ??= `${stack[stack.length - 1]!.char} from ${at(stack[stack.length - 1]!.open)} is never closed`;
  return { masked: out.join(''), pairs, unbalanced };
}

// ── The two kinds of site ────────────────────────────────────────────────────

const OLDER = ['agent_id', 'timestamp', 'subject_pod_url'];
interface Site { readonly file: string; readonly line: number; readonly kind: 'list' | 'destructuring'; readonly text: string; readonly namesClientId: boolean }

/** The pair's own text: nested pairs' insides blanked, so only what is directly inside it is read. */
function ownText(masked: string, pair: Pair): string {
  const chars = masked.slice(pair.open + 1, pair.close).split('');
  for (const child of pair.children) for (let k = child.open + 1; k < child.close; k++) chars[k - pair.open - 1] = ' ';
  return chars.join('');
}

/** Whether the object pattern `own` names `key` as a property: shorthand, renamed, defaulted or quoted. */
function namesProperty(own: string, pair: Pair, masked: string, key: string): boolean {
  if (new RegExp(`(?:^|[\\s,])${key}\\s*(?=[:,=]|$)`).test(own)) return true;
  return pair.strings.some((s) => s.value === key && /^\s*:/.test(masked.slice(s.end)));
}

/** Whether the `{...}` pair is a pattern being destructured: `} =`, `}: T =`, or a parameter `}) =>` / `}) {` / `}): T`. */
function isPattern(masked: string, pair: Pair): boolean {
  const after = masked.slice(pair.close + 1, pair.close + 400);
  if (/^\s*=(?![=>])/.test(after)) return true;
  if (/^\s*:[^;=\n]*=(?![=>])/.test(after)) return true;
  return /^\s*\)\s*(?:=>|\{|:)/.test(after);
}

/** Every site in one file's text. */
function sitesIn(file: string, text: string): { sites: Site[]; unbalanced: string | null } {
  const { masked, pairs, unbalanced } = lex(text);
  const lineOf = (offset: number): number => text.slice(0, offset).split('\n').length;
  const sites: Site[] = [];
  for (const pair of pairs) {
    if (pair.char === '[' || pair.char === '(') {
      const values = new Set(pair.strings.map((s) => s.value));
      if (OLDER.every((v) => values.has(v))) {
        sites.push({ file, line: lineOf(pair.open), kind: 'list', text: text.slice(pair.open, pair.close + 1).replace(/\s+/g, ' ').slice(0, 200), namesClientId: values.has('client_id') });
      }
      continue;
    }
    const own = ownText(masked, pair);
    if (!/\.\.\.\s*[A-Za-z_$][\w$]*\s*$/.test(own)) continue;
    if (!namesProperty(own, pair, masked, 'subject_pod_url') || !isPattern(masked, pair)) continue;
    sites.push({ file, line: lineOf(pair.open), kind: 'destructuring', text: text.slice(pair.open, pair.close + 1).replace(/\s+/g, ' ').slice(0, 200), namesClientId: namesProperty(own, pair, masked, 'client_id') });
  }
  return { sites, unbalanced };
}

// ── The repository ───────────────────────────────────────────────────────────

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n')
  .filter((f) => /\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx)$/.test(f) && !/\.d\.[cm]?ts$/.test(f))
  .filter((f) => !/(?:^|\/)(?:tests?|node_modules|dist|build|build-ts|evidence|coverage)\//.test(f) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(f));

const sites: Site[] = [];
const notUnderstood: string[] = [];
const scanned: string[] = [];
for (const file of files) {
  let text: string;
  try { text = readFileSync(join(ROOT, file), 'utf8'); } catch { continue; }
  if (!text.includes('subject_pod_url')) continue;
  scanned.push(file);
  const found = sitesIn(file, text);
  sites.push(...found.sites);
  if (found.unbalanced) notUnderstood.push(`${file}: ${found.unbalanced}`);
}
const report = (s: Site): string => `${s.file}:${s.line}: ${s.text}`;

// ── Prose ────────────────────────────────────────────────────────────────────

const PROSE = /\b(?:relay\s+(?:adds|supplies|stamps)|relay-added|automatically\s+stamped)\b/gi;
interface Sentence { readonly file: string; readonly line: number; readonly text: string; readonly namesClientId: boolean }
/** Each sentence that says what the relay adds and names the pod stamp, with whether it or the next one names client_id. */
function proseIn(file: string, text: string): Sentence[] {
  const out: Sentence[] = [];
  for (const m of text.matchAll(PROSE)) {
    const from = m.index;
    const rest = text.slice(from, from + 1500);
    const ends = [...rest.matchAll(/\.(?=\s|$)/g)].map((e) => e.index);
    const first = rest.slice(0, ends[0] ?? rest.length);
    if (!/subject_pod_url|pod[- ]stamp/i.test(first)) continue;
    const window = rest.slice(0, ends[1] ?? rest.length);
    out.push({ file, line: text.slice(0, from).split('\n').length, text: first.replace(/\s+/g, ' ').slice(0, 200), namesClientId: /client_id/.test(window) });
  }
  return out;
}
const sentences: Sentence[] = [];
for (const file of execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n')) {
  if (!/\.(?:md|ts|mts|js|mjs|html)$/.test(file) || file === 'CHANGELOG.md' || /\.d\.[cm]?ts$/.test(file)) continue;
  if (/(?:^|\/)(?:tests?|node_modules|dist|build|build-ts|evidence|coverage)\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
  let text: string;
  try { text = readFileSync(join(ROOT, file), 'utf8'); } catch { continue; }
  if (!PROSE.test(text)) { PROSE.lastIndex = 0; continue; }
  PROSE.lastIndex = 0;
  sentences.push(...proseIn(file, text));
}

describe('the detector', () => {
  const probe = (text: string): Site[] => sitesIn('probe.ts', text).sites;
  it('finds a list in double quotes, a multi-line list, a Set, and an argument list', () => {
    expect(probe('const a = new Set(["agent_id", "timestamp", "subject_pod_url"]);')).toMatchObject([{ kind: 'list', namesClientId: false }]);
    expect(probe("const b = [\n  'agent_id',\n  'timestamp',\n  'subject_pod_url',\n];")).toMatchObject([{ kind: 'list', namesClientId: false, line: 1 }]);
    expect(probe('const c = [`agent_id`, `timestamp`, `subject_pod_url`, `client_id`];')).toMatchObject([{ kind: 'list', namesClientId: true }]);
    expect(probe("exact(body, 'agent_id', 'timestamp', 'subject_pod_url', 'client_id');")).toMatchObject([{ kind: 'list', namesClientId: true }]);
  });
  it('finds a shorthand, a renamed, a quoted and a parameter destructuring before a rest element', () => {
    const shorthand = "const { agent_id, timestamp, subject_pod_url, ...rest } = p;\nif (Object.keys(rest).some((k) => !['outcome'].includes(k))) throw new Error('x');";
    expect(probe(shorthand)).toMatchObject([{ kind: 'destructuring', namesClientId: false }]);
    expect(probe('const {\n  agent_id: _a,\n  subject_pod_url: _p,\n  client_id: _c,\n  ...settings\n} = bound.payload;')).toMatchObject([{ kind: 'destructuring', namesClientId: true }]);
    expect(probe("const { 'subject_pod_url': _p, ...o }: Record<string, unknown> = x;")).toMatchObject([{ kind: 'destructuring', namesClientId: false }]);
    expect(probe('const f = ({ subject_pod_url, client_id, ...rest }) => rest;')).toMatchObject([{ kind: 'destructuring', namesClientId: true }]);
  });
  it('leaves alone what is not a closed list: an object being built, a comment, a string, a lookup by other names', () => {
    expect(probe('const o = { ...safe, agent_id: a, subject_pod_url: p, ...more };')).toEqual([]);
    expect(probe('send({ subject_pod_url, ...rest });')).toEqual([]);
    expect(probe("// ['agent_id', 'timestamp', 'subject_pod_url']\nconst s = \"['agent_id', 'timestamp', 'subject_pod_url']\";")).toEqual([]);
    expect(probe("const r = /['\"[]/g; const l = ['agent_id', 'timestamp', 'subject_pod_url', 'client_id'];")).toMatchObject([{ kind: 'list', namesClientId: true }]);
    expect(probe("const t = `${a ? '[' : ''}`; const l = ['agent_id', 'timestamp', 'subject_pod_url'];")).toMatchObject([{ kind: 'list', namesClientId: false }]);
  });
  it('notices a file it does not understand', () => {
    expect(sitesIn('probe.ts', 'const a = [1, 2;').unbalanced).toMatch(/never closed|closes/);
  });
});

describe('prose that says what the relay adds', () => {
  it('is read: a sentence naming the pod stamp, and the next sentence', () => {
    expect(proseIn('p.md', 'The relay adds `agent_id`, `subject_pod_url` and a timestamp. Nothing else.')).toMatchObject([{ namesClientId: false, line: 1 }]);
    expect(proseIn('p.md', 'The\nrelay supplies the session agent, own-pod stamp and fresh signature timestamp. It may also add client_id.')).toMatchObject([{ namesClientId: true }]);
    expect(proseIn('p.md', 'The relay supplies agent_id and the fresh timestamp.')).toEqual([]);
  });
  it('names client_id wherever it lists the pod stamp', () => {
    const at = (path: string): boolean => sentences.some((s) => s.file === path);
    expect(at('deploy/identity/PROVISIONAL-PLAY.md')).toBe(true);
    expect(at('applications/foxxi-content-intelligence/affordances.ts')).toBe(true);
    expect(at('applications/foxxi-content-intelligence/README.md')).toBe(true);
    expect(at('applications/foxxi-content-intelligence/PRIVATE-PERFORMANCE-FEEDBACK.md')).toBe(true);
    expect(at('applications/agentic-performance-practice/compatibility/private-performance-schema.ts')).toBe(true);
    expect(at('docs/skills/foxxi/reference.md')).toBe(true);
    expect(sentences.filter((s) => !s.namesClientId).map((s) => `${s.file}:${s.line}: ${s.text}`)).toEqual([]);
  });
});

describe("the relay's client_id is a transport field wherever the relay's fields are listed", () => {
  it('understood every file it read (a lexer slip would silently skip the rest of a file)', () => {
    expect(scanned.length).toBeGreaterThan(20);
    expect(notUnderstood).toEqual([]);
  });

  it('finds the closed lists and strip lists it was written against', () => {
    const at = (path: string, kind: Site['kind'] = 'list'): boolean => sites.some((s) => s.file === path && s.kind === kind);
    expect(at('applications/agentic-performance-practice/compatibility/private-performance-routes.ts')).toBe(true);
    expect(at('applications/agentic-performance-practice/compatibility/foxxi-performance-routes.ts')).toBe(true);
    expect(at('applications/foxxi-content-intelligence/src/directory-actions.ts')).toBe(true);
    expect(at('applications/foxxi-content-intelligence/src/i2idlx-agent-sessions.ts')).toBe(true);
    expect(at('applications/foxxi-content-intelligence/src/lti-own-reconciliation.ts')).toBe(true);
    expect(at('applications/foxxi-content-intelligence/src/lti-own-reconciliation-http.ts')).toBe(true);
    expect(at('applications/foxxi-content-intelligence/src/relay-signed-fields.ts')).toBe(true);
    expect(at('applications/work-redesign/bridge/ui.ts')).toBe(true);
    expect(at('deploy/mcp-relay/server.ts')).toBe(true);
  });

  it("every list naming agent_id, timestamp and subject_pod_url also names client_id", () => {
    expect(sites.filter((s) => s.kind === 'list' && !s.namesClientId).map(report)).toEqual([]);
  });

  it('every destructuring that sets subject_pod_url aside before a rest element sets client_id aside too', () => {
    expect(sites.filter((s) => s.kind === 'destructuring' && !s.namesClientId).map(report)).toEqual([]);
  });
});
