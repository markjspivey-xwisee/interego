/**
 * Find `return { … }` statements in TypeScript source, by SCANNING rather than pattern-matching.
 *
 * ── WHY A SCANNER AND NOT A REGEX ────────────────────────────────────────────
 *
 * Three separate gates in this repo censused handler returns with a regex, and an audit broke
 * every one of them. The failures were all the same shape — a regex cannot count braces or know
 * it is inside a string:
 *
 *   `[^}]*`        forbids ANY `}` before the keyword, so a return whose object contains a
 *                  NESTED object (`{ error, 'iep:resolvedBy': { … } }`) is invisible. That is
 *                  most of the interesting refusals, because a refusal that names its way out
 *                  has a nested object by definition.
 *   bound at `;`   truncated at a semicolon INSIDE a message ("your own pod; the first
 *                  enrollee owns it."), hiding the fields after it.
 *   bound at `};`  never matches `res.status(…).json({ … });`, so of two IDENTICAL refusals one
 *                  was censused and the other was absent from every leg.
 *   fixed window   overran into neighbouring code and reported four CORRECT results as defects.
 *
 * Each fix moved the blindness rather than removing it, because the problem is not the pattern
 * — it is that matching balanced, string-bearing syntax with a regex cannot be made correct.
 * This counts braces and skips string, template and comment content, which is the smallest
 * thing that actually works.
 *
 * It is deliberately NOT a TypeScript parser: it needs to answer one question (where does this
 * object literal end) and a parser would be a dependency and a second thing to be wrong.
 */

/** A `return { … }` (or `res.status(…).json({ … })`) statement, with its full object text. */
export interface ReturnObject {
  /** The whole matched statement, from `return`/`.json(` through the closing brace. */
  readonly text: string;
  /** 1-indexed line in the source passed in. */
  readonly line: number;
}

/**
 * Scan forward from the `{` at `open`, returning the index just past its matching `}`.
 * Skips '…', "…", `…` (including `${}` nesting), // … and block comments so punctuation inside them
 * never closes the object. Returns -1 if unbalanced (a truncated file, or a scan bug).
 */
function endOfObject(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '/' && next === '/') { const nl = src.indexOf('\n', i); if (nl === -1) return -1; i = nl + 1; continue; }
    if (c === '/' && next === '*') { const e = src.indexOf('*/', i + 2); if (e === -1) return -1; i = e + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          // A template hole can contain braces and further strings — scan it as an object.
          const e = endOfObject(src, i + 1);
          if (e === -1) return -1;
          i = e;
          continue;
        }
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === '{') { depth += 1; i += 1; continue; }
    if (c === '}') { depth -= 1; i += 1; if (depth === 0) return i; continue; }
    i += 1;
  }
  return -1;
}

const lineOf = (src: string, index: number): number => src.slice(0, index).split('\n').length;

/**
 * Every `return { … }` and `res.status(…).json({ … })` in `src`, whole.
 *
 * Both forms are included because they are the two ways this codebase answers a caller, and a
 * census that saw only one of them reported a clean sheet while the other carried an untyped
 * refusal.
 */
export function returnObjects(src: string): ReturnObject[] {
  const out: ReturnObject[] = [];
  // ★ THE `res.status(…)` PREFIX IS PART OF THE STATEMENT AND MUST BE CAPTURED WITH IT.
  //
  // Matching `.json({` alone captures the object but not the status set one call to its left,
  // so every Express route in the bridge looked like an un-statused answer — 138 of them, which
  // is a false-positive flood that would have buried the real findings and got the gate
  // ignored. A `.json({…})` answer is statused by its `res.status(NNN)`, so read them together.
  // The chain between `.status(…)` and `.json(` is arbitrary — `.type('application/ld+json')`
  // sits there on every ontology route — so allow any number of intervening calls. Requiring
  // them to be adjacent reported three correctly-404'd term lookups as un-statused answers.
  const starts = [...src.matchAll(
    /return\s*\{|res\s*\.\s*status\s*\([^)]*\)(?:\s*\.\s*\w+\s*\([^)]*\))*\s*\.\s*json\s*\(\s*\{|\.json\s*\(\s*\{/g,
  )];
  for (const m of starts) {
    const open = src.indexOf('{', m.index!);
    if (open === -1) continue;
    const end = endOfObject(src, open);
    if (end === -1) continue;
    out.push({ text: src.slice(m.index!, end), line: lineOf(src, m.index!) });
  }
  return out;
}
