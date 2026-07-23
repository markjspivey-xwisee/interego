/**
 * Turtle/RDF escaping for hand-built graph text.
 *
 * Several publishers build Turtle/TriG by interpolating values into `<IRI>`
 * and `"literal"` positions. When any interpolated value is caller-influenced,
 * an unescaped `>` (in an IRI) or `"`/newline (in a literal) breaks out of its
 * token and injects arbitrary triples into the graph written to a pod — a
 * cross-agent provenance/attribution forgery + parse-corruption vector. Every
 * such sink MUST route its IRIs through `iesc()` and its string literals through
 * `tesc()`. Centralized here so the escaping cannot drift between sinks (each
 * ad-hoc copy was a place the next one got forgotten).
 */

/** Escape a value for a Turtle STRING_LITERAL_QUOTE ("..."). Backslash first,
 *  then quote and the control chars Turtle forbids raw in a quoted literal. */
export function tesc(s: string): string {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** Percent-encode any character illegal in a Turtle IRIREF (`<...>`): angle
 *  brackets, quotes, braces, pipe, caret, backtick, backslash, and whitespace/
 *  control chars (\x00–\x20). A value that survives this cannot break out of
 *  `<...>` to inject triples or relations. */
export function iesc(s: string): string {
  return String(s).replace(/[\x00-\x20<>"{}|^`\\]/g, encodeURIComponent);
}
