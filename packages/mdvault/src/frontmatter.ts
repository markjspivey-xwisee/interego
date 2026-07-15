/**
 * Hardened YAML-LD frontmatter parsing (the YAML attack surface — threat class E).
 *
 * A note is `---\n<frontmatter>\n---\n<body>`. The body is NEVER parsed (rung-1 prose,
 * kept byte-exact by the caller's content-addressed atom); only the frontmatter block is
 * parsed, and it is fully attacker-controlled, so every js-yaml foot-gun is closed:
 *
 *  - `JSON_SCHEMA` (never DEFAULT/CORE): no implicit `!!timestamp`/`!!binary`/`yes`->bool/
 *    `0x`->int/`!!js` coercions, so a value the lift expects to be a string never arrives
 *    as a Date/number/constructed object (E1 tag confusion).
 *  - `json: false` (js-yaml's default): a DUPLICATE mapping key THROWS instead of last-key-
 *    wins, so the object the lift consumes is exactly the one a validator saw (A11/E2).
 *  - anchors/aliases/merge-keys are refused by a quote-aware pre-scan, killing billion-
 *    laughs alias expansion and `<<`-merge key-smuggling (A11/E1) before js-yaml runs.
 *  - `__proto__`/`constructor`/`prototype` keys are refused and every map is rebuilt with
 *    a null prototype (E1 prototype pollution).
 *  - byte-size, depth, and node-count bounds are enforced (E3 resource abuse).
 */
import { VaultInputError } from './errors.js';
import yaml from 'js-yaml';

export interface FrontmatterLimits {
  /** max frontmatter block size in bytes (UTF-8). */
  readonly maxBytes: number;
  /** max mapping/sequence nesting depth. */
  readonly maxDepth: number;
  /** max total nodes (keys + sequence elements) across the parsed tree. */
  readonly maxNodes: number;
}

export const DEFAULT_FRONTMATTER_LIMITS: FrontmatterLimits = Object.freeze({
  maxBytes: 256 * 1024,
  maxDepth: 32,
  maxNodes: 10_000,
});

const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface SplitNote {
  /** the raw frontmatter block text (between the delimiters), or null if none. */
  readonly frontmatter: string | null;
  /** everything after the closing delimiter — the body, byte-exact. */
  readonly body: string;
  /** true iff a well-formed `---\n … \n---` frontmatter block opened AND closed. */
  readonly hasFrontmatter: boolean;
}

/**
 * Split a note into its frontmatter block and body WITHOUT parsing. A note participates
 * in the graph only if it has a closed frontmatter block (Vault-LD §4.4.1); a missing or
 * unterminated block yields `hasFrontmatter:false` and the whole text as body (rung 1).
 * Deterministic: the opening `---` must be the very first line.
 */
export function splitNote(text: string): SplitNote {
  if (typeof text !== 'string') {
    throw new VaultInputError('note.type', 'note content must be a string');
  }
  // Opening fence must be the first line: `---` then a line break.
  const m = /^---\r?\n/.exec(text);
  if (!m) return { frontmatter: null, body: text, hasFrontmatter: false };
  const rest = text.slice(m[0].length);
  // Closing fence: a line that is exactly `---` (optionally CRLF). Scan line starts.
  const close = /(?:^|\n)---[ \t]*(?:\r?\n|$)/.exec(rest);
  if (!close) return { frontmatter: null, body: text, hasFrontmatter: false };
  const fmEnd = close.index + (close[0].startsWith('\n') ? 1 : 0);
  const frontmatter = rest.slice(0, fmEnd);
  const body = rest.slice(close.index + close[0].length);
  return { frontmatter, body, hasFrontmatter: true };
}

/** YAML anchor (`&x`), alias (`*x`), and merge (`<<`) syntax, OUTSIDE quotes/comments,
 *  is refused. Masks `"..."`/`'...'` and `#` comments first so a literal `&`/`*` inside a
 *  scalar (e.g. `R&D`, `"a * b"`) is not a false positive. */
function rejectDangerousYaml(fm: string): void {
  for (const rawLine of fm.split('\n')) {
    // Mask quoted scalars, then strip a trailing comment.
    let line = rawLine
      .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
      .replace(/'(?:[^']|'')*'/g, ' ');
    const hash = line.indexOf('#');
    if (hash >= 0) line = line.slice(0, hash);
    // Merge key.
    if (/(^|[\s{[,])<<\s*:/.test(line)) {
      throw new VaultInputError('yaml.merge-key', 'frontmatter uses a YAML merge key (<<), which is refused');
    }
    // Anchor/alias: `&name` or `*name` at a token start (after ws / : / - / [ / { / ,).
    if (/(^|[\s:\-[{,])[&*][^\s&*]/.test(line)) {
      throw new VaultInputError('yaml.anchor-alias', 'frontmatter uses a YAML anchor/alias (&/*), which is refused');
    }
  }
}

/** Recursively enforce bounds, refuse prototype-polluting keys, and rebuild every mapping
 *  with a null prototype. Returns a sanitized clone whose objects cannot pollute. */
function sanitize(value: unknown, limits: FrontmatterLimits, depth: number, counter: { n: number }): unknown {
  if (depth > limits.maxDepth) {
    throw new VaultInputError('yaml.depth', `frontmatter exceeds max nesting depth ${limits.maxDepth}`);
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const el of value) {
      if (++counter.n > limits.maxNodes) {
        throw new VaultInputError('yaml.nodes', `frontmatter exceeds max node count ${limits.maxNodes}`);
      }
      out.push(sanitize(el, limits, depth + 1, counter));
    }
    return out;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (PROTO_KEYS.has(key)) {
      throw new VaultInputError('yaml.proto-key', `frontmatter key "${key}" is refused (prototype pollution)`);
    }
    if (++counter.n > limits.maxNodes) {
      throw new VaultInputError('yaml.nodes', `frontmatter exceeds max node count ${limits.maxNodes}`);
    }
    out[key] = sanitize((value as Record<string, unknown>)[key], limits, depth + 1, counter);
  }
  return out;
}

/**
 * Parse a frontmatter block to a null-prototype object graph, or throw VaultInputError.
 * The top level MUST be a mapping (a bare scalar/sequence is not valid frontmatter).
 */
export function parseFrontmatter(
  fm: string,
  limits: FrontmatterLimits = DEFAULT_FRONTMATTER_LIMITS,
): Record<string, unknown> {
  const bytes = Buffer.byteLength(fm, 'utf8');
  if (bytes > limits.maxBytes) {
    throw new VaultInputError('yaml.size', `frontmatter is ${bytes} bytes, over the ${limits.maxBytes} limit`);
  }
  rejectDangerousYaml(fm);
  let parsed: unknown;
  try {
    parsed = yaml.load(fm, { schema: yaml.JSON_SCHEMA, json: false });
  } catch (e) {
    // js-yaml throws on duplicate keys (json:false) and on syntax errors.
    throw new VaultInputError('yaml.parse', `frontmatter is not valid YAML-LD: ${(e as Error).message}`);
  }
  if (parsed === null || parsed === undefined) {
    return Object.create(null) as Record<string, unknown>;
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VaultInputError('yaml.not-mapping', 'frontmatter must be a YAML mapping, not a scalar or sequence');
  }
  return sanitize(parsed, limits, 0, { n: 0 }) as Record<string, unknown>;
}
