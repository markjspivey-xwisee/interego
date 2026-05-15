/**
 * @module rdf/escape
 * @description Single source of truth for escaping a string into a Turtle /
 * TriG `"..."` literal.
 *
 * Turtle's STRING_LITERAL_QUOTE production forbids unescaped `"`, `\`,
 * LF, CR, and TAB inside a `"..."` literal. Helpers scattered across
 * the codebase used to each cover a different subset, which produced
 * malformed Turtle whenever a value happened to contain a control
 * character (e.g., a `foaf:nick` like `"alice\nmalicious"`).
 *
 * Use {@link escapeTurtleLiteral} on every value you interpolate into a
 * single-quoted Turtle string. For `"""..."""` triple-quoted strings,
 * the same helper is also valid — over-escaping is always legal Turtle.
 *
 * No new ontology terms. No runtime deps. L1-friendly.
 */

/**
 * Escape a JavaScript string for safe inclusion in a single-quoted
 * Turtle literal (`"..."`).
 *
 * Covers every character the inverse pass {@link unescapeTurtleLiteral}
 * decodes, so a value round-trips losslessly through publish + parse.
 * Order matters: backslash MUST be replaced first, or the per-character
 * escapes that introduce a backslash get themselves doubled.
 */
export function escapeTurtleLiteral(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Inverse of {@link escapeTurtleLiteral} — decode the five escapes the
 * Turtle STRING_LITERAL_QUOTE production defines for `"..."`. Any
 * other `\x` sequence is passed through as the literal character `x`
 * (defensive — Turtle technically rejects unknown escapes, but a
 * federated parser is more useful when it tolerates them).
 */
export function unescapeTurtleLiteral(s: string): string {
  return s.replace(/\\(["\\nrt])/g, (_, c) => {
    switch (c) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      default: return c;
    }
  });
}
