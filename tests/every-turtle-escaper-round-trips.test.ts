/**
 * Every named Turtle-literal escaper in the tree must survive the values a caller can actually send.
 *
 * ★★ WHAT THIS WAS WRITTEN AFTER, AND WHY THE ORIGINAL DIAGNOSIS WAS WRONG.
 *
 * An audit recorded "five copies of the Turtle escaper, only one correct" and called it the
 * primary RDF-injection defence. Measured — by lifting each shipped function out of its file and
 * attacking it through a real parse — both halves of that were off:
 *
 *   - there were ELEVEN named escapers, not five;
 *   - NONE produced extra triples. The `\` and `"` handling, including the order that matters,
 *     was correct in all of them, so none was injectable.
 *
 * The real defect was quieter. Six covered a different subset of { \ " \n \r \t }, and Turtle's
 * STRING_LITERAL_QUOTE forbids raw LF, CR and TAB — so any value with a newline produced a
 * document that would not parse, and the publish failed. One was worse than that:
 * `ler-tla-vocab`'s `esc` replaced a newline with a SPACE. Not an escape — a silent content
 * change, where the value published came back different from the value handed in.
 *
 * ── WHY THIS TEST IS BEHAVIOURAL AND DISCOVERS ITS OWN TARGETS ──────────────────────────────
 *
 * The tempting guard is syntactic: forbid `.replace(/\\/g, '\\\\')` outside the core helper. That
 * cannot land — there are ~80 such inline chains across probes, desktop tools and publishers, so
 * it would need an allowlist on day one, and an allowlisted gate is the thing that lets the next
 * one through. This asserts the PROPERTY instead: whatever a function named like an escaper does,
 * a value must round-trip through it losslessly. It scans for its own targets, so a new escaper
 * is covered the moment it is written, without anyone remembering to register it.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'n3';
import { escapeTurtleLiteral } from '@interego/core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCAN = ['applications', 'integrations', 'deploy', 'packages'];
const SKIP = new Set(['node_modules', 'dist', 'coverage', '.git']);

/** Values that break each thing a Turtle literal escape has to handle. */
const PAYLOADS: readonly { name: string; v: string }[] = [
  { name: 'quote + predicate', v: 'x" ; <http://ex/injected> "yes' },
  { name: 'trailing backslash', v: 'ends with a backslash\\' },
  { name: 'newline', v: 'line1\nline2' },
  { name: 'carriage return', v: 'line1\rline2' },
  { name: 'tab', v: 'col1\tcol2' },
  { name: 'triple quote', v: 'has """ inside' },
];

interface Found { readonly file: string; readonly name: string; readonly src: string }

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const full = join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) yield* walk(full);
    else if (/\.ts$/.test(e) && !/\.(test|spec)\.ts$/.test(e)) yield full;
  }
}

/** Named single-string→string functions whose name says "escaper". */
function discover(): Found[] {
  const out: Found[] = [];
  const sig = /function\s+(esc|escape|escapeLit|escapeMulti|escapeTtl|escapeTurtleLiteral|ttlEscape)\s*\(\s*\w+\s*:\s*string\s*\)\s*:\s*string\s*\{/g;
  for (const dir of SCAN) {
    let base: string;
    try { base = join(ROOT, dir); statSync(base); } catch { continue; }
    for (const file of walk(base)) {
      const text = readFileSync(file, 'utf8');
      sig.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = sig.exec(text)) !== null) {
        const open = text.indexOf('{', m.index);
        let depth = 0;
        for (let j = open; j < text.length; j++) {
          if (text[j] === '{') depth++;
          else if (text[j] === '}') {
            depth--;
            if (depth === 0) {
              out.push({ file: file.slice(ROOT.length).replace(/\\/g, '/'), name: m[1] ?? '', src: text.slice(m.index, j + 1) });
              break;
            }
          }
        }
      }
    }
  }
  return out;
}

/** Evaluate the SHIPPED source, with the core helper in scope exactly as it is at runtime. */
function compile(src: string): (s: string) => string {
  const js = src
    .replace(/:\s*string/g, '')
    // Strip non-null assertions (`x!`, `f()!`) but never `!=`, `!==`, or a leading `!x`.
    .replace(/([A-Za-z0-9_$)\]])!(?!=)/g, '$1')
    .replace(/^function\s+\w+/, 'function');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function('escapeTurtleLiteral', `return (${js});`)(escapeTurtleLiteral) as (s: string) => string;
}

const found = discover();

describe('every named Turtle escaper round-trips', () => {
  it('finds the escapers at all — a vacuous pass here would hide every case below', () => {
    expect(found.length, 'discovered no escaper functions; the signature scan is wrong').toBeGreaterThan(8);
  });

  for (const f of found) {
    it(`${f.file}:${f.name}`, () => {
      const fn = compile(f.src);
      for (const p of PAYLOADS) {
        const ttl = `<http://ex/s> <http://ex/p> "${fn(p.v)}" .`;
        let quads;
        try {
          quads = new Parser().parse(ttl);
        } catch (err) {
          throw new Error(
            `${p.name}: produced Turtle that does not parse (${(err as Error).message.slice(0, 60)}). `
            + `Turtle forbids a raw ", \\, LF, CR or TAB in a "…" literal — use escapeTurtleLiteral `
            + `from @interego/core rather than a local subset.`,
          );
        }
        expect(quads.length, `${p.name}: escaped to ${quads.length} triples — the value escaped its literal`).toBe(1);
        expect(quads[0]?.object.value, `${p.name}: value did not round-trip`).toBe(p.v);
      }
    });
  }
});
