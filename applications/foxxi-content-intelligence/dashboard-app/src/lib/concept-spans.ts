/**
 * The concept-highlighting SCAN, extracted from `HighlightedTranscript` so it can be
 * asserted without rendering React.
 *
 * ★ WHY IT IS A SEPARATE FILE. The defect this scan was carrying — a plain-text advance of
 * `text.indexOf(' ', i) + 1`, which swallowed the whole token behind any non-space
 * delimiter, so `we use (backpropagation) here` highlighted NOTHING — lived inside a
 * component that no test in this repo renders. The fix was measured by hand and then had no
 * guard, which is the same shape as the bug: correct code with nothing holding it there.
 * Splitting the pure part out is what makes it table-testable, and
 * `tests/concept-nav-graph.test.ts` is where the table lives.
 *
 * Deliberately dependency-free — no React, no `CourseConcept` import. It takes the two
 * fields it reads, so `tsconfig.check.json` can compile it from a plain node test without
 * dragging the dashboard's JSX and `import.meta.env` surface into that program.
 */

/** The minimum a concept must expose for the scan. `CourseConcept` structurally satisfies it. */
export interface LabelledConcept {
  readonly id: string;
  readonly label: string;
}

/** One run of the transcript: either literal text, or a concept hit to wrap in a `<mark>`. */
export type ConceptSpan<C extends LabelledConcept> =
  | { readonly kind: 'text'; readonly start: number; readonly text: string }
  | { readonly kind: 'concept'; readonly start: number; readonly text: string; readonly concept: C };

/** A match may not begin or end inside an alphabetic run — the "word-boundary-ish" rule. */
const isAlpha = (ch: string | undefined): boolean => ch !== undefined && /[a-z]/i.test(ch);

/**
 * Walk `text` once, greedily wrapping the longest matching concept label at each position.
 *
 * Labels are sorted longest-first so a short label cannot shadow a longer one that starts at
 * the same index, and labels under three characters are dropped — at that length nearly every
 * transcript is a match and the highlighting stops meaning anything.
 */
export function conceptSpans<C extends LabelledConcept>(
  text: string,
  concepts: readonly C[],
): ConceptSpan<C>[] {
  if (!text) return [];
  const sorted = [...concepts]
    .filter(c => c.label && c.label.length >= 3)
    .sort((a, b) => b.label.length - a.label.length);

  const spans: ConceptSpan<C>[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    let hit: C | null = null;
    let end = i;
    for (const c of sorted) {
      const label = c.label.toLowerCase();
      if (!lower.startsWith(label, i)) continue;
      const trailIdx = i + label.length;
      if (!isAlpha(text[i - 1]) && !isAlpha(text[trailIdx])) {
        hit = c;
        end = trailIdx;
        break;
      }
    }
    if (hit !== null) {
      spans.push({ kind: 'concept', start: i, text: text.slice(i, end), concept: hit });
      i = end;
      continue;
    }
    // ★ ADVANCE TO THE NEXT POSITION THAT COULD START A MATCH — NOT TO THE NEXT SPACE.
    //
    // A match requires a non-alpha char before it, so no match can begin inside an
    // alphabetic run: the whole run is skippable in one chunk. EVERY other character is a
    // legal boundary, so those advance exactly one. The rule this replaced consumed to the
    // next space, which meant a match was only ever attempted at index 0 or immediately
    // after a space — `(backpropagation)`, `\nbackpropagation` and `a-backpropagation-b`
    // all went unhighlighted. Measured: OLD yields [] for all three, NEW yields the concept,
    // while `backpropagationX` stays unmatched under both (the trailing-alpha guard).
    //
    // Dropping the alpha-run skip so this always does `j = i + 1` leaves the output
    // IDENTICAL and only slower — it is an optimisation, not a rule, and is asserted as
    // such below rather than dressed up as a timing test.
    let j = i;
    if (isAlpha(text[i])) {
      while (j < text.length && isAlpha(text[j])) j++;
    } else {
      j = i + 1;
    }
    spans.push({ kind: 'text', start: i, text: text.slice(i, j) });
    i = j;
  }
  return spans;
}

/** The concept ids the scan actually highlighted, in order of first appearance. */
export function highlightedConceptIds(spans: readonly ConceptSpan<LabelledConcept>[]): string[] {
  const out: string[] = [];
  for (const s of spans) {
    if (s.kind === 'concept' && !out.includes(s.concept.id)) out.push(s.concept.id);
  }
  return out;
}
