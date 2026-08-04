/**
 * ONE comment stripper for every gate that asserts about SOURCE TEXT — and it parses
 * instead of pattern-matching, because the pattern-matching version deleted code.
 *
 * ── THE MEASURED DEFECT ──────────────────────────────────────────────────────
 *
 * Three gates each carried their own copy of
 *
 *     src.replace(/\/\*[\s\S]*?\*\//g, '')      // "strip block comments"
 *
 * applied to RAW source, before line comments were removed. `/*` is two ordinary
 * characters, and `deploy/mcp-relay/server.ts` contains them inside `//` comments and
 * inside string literals — `// ── /amep/* — AMEP engine …`, `// CORS (ACAO:*) via the
 * /ns/* carve-out`, `// up here and then write via POST /tool/*`, and an Accept header
 * literal ending in star-slash-star. Each of those OPENS a phantom block comment that
 * the regex closes at the next real star-slash, so the stripper deleted the code
 * in between. Measured on server.ts: 14,442 lines in, 9,068 lines out — six spans,
 * ~596 lines of executable code, gone from the view the assertions read.
 *
 * That is not a cosmetic loss. It is the SAME defect the strippers were introduced to
 * prevent, with the polarity flipped: a comment could no longer satisfy an assertion,
 * but it could now DELETE the code an assertion was about. Exploited to confirm it,
 * against `tests/cors-allowlist.test.ts` > "does NOT enable Access-Control-Allow-
 * Credentials in any deploy server":
 *
 *   • inserting a real `res.setHeader('Access-Control-Allow-Credentials','true')`
 *     middleware line INSIDE one of the eaten spans → the guard PASSED (defeated);
 *   • the identical line 11,000 lines earlier, outside every span → the guard FAILED,
 *     as it should.
 *
 * ── WHY THE TYPESCRIPT PARSER AND NOT A BETTER REGEX ─────────────────────────
 *
 * Every regex answer to this reintroduces it one layer down. Strip `//` first and a
 * `'http://x'` literal loses its scheme; skip string literals with a regex and a regex
 * LITERAL that itself spells the comment delimiters — which the very files being
 * scanned contain — becomes the next phantom. "Is this `/` a comment, a division, or a
 * regex"
 * is exactly the question a tokeniser answers and a pattern cannot.
 *
 * So the source is parsed and the parser's OWN comment ranges are removed. `typescript`
 * is a DECLARED devDependency of both this package and the repo root (not a transitive
 * one) — a gate whose helper can stop resolving is a gate that stops gating.
 *
 * Removal is length-REDUCING, deliberately: several callers assert that two tokens are
 * within N characters of each other, and the whole point of stripping is that a long
 * explanation between them must not push them apart. Blanking comments to whitespace
 * would preserve the distance and re-break those assertions.
 */
import ts from 'typescript';

/** JS files (deploy/css-gate/server.mjs) must not be parsed as TypeScript. */
function scriptKindFor(fileName: string): ts.ScriptKind {
  if (/\.(mjs|cjs|js)$/.test(fileName)) return ts.ScriptKind.JS;
  if (/\.tsx$/.test(fileName)) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

/**
 * `src` with every comment removed and everything else — string literals, template
 * literals, regex literals, the shebang — left byte-for-byte intact.
 *
 * `fileName` only selects the parser dialect; it is never read from disk.
 */
export function stripComments(src: string, fileName = 'source.ts'): string {
  const sf = ts.createSourceFile(
    fileName, src, ts.ScriptTarget.Latest, /* setParentNodes */ true, scriptKindFor(fileName),
  );

  // Walk to the LEAVES — `getChildren` yields tokens, `forEachChild` does not and would
  // miss the comment before a closing brace.
  //
  // BOTH range queries are needed and finding that out cost a red self-test. TypeScript
  // splits trivia the way a reader does: a comment on the SAME line as the code before it
  // is that token's TRAILING comment, and only a comment after a line break is the next
  // token's LEADING one. Asking for leading ranges alone left every end-of-line `//` in
  // place — including `const url = 'http://…';  // a // inside a string literal`, which is
  // precisely the shape the callers must not see.
  const cuts: Array<[number, number]> = [];
  const walk = (node: ts.Node): void => {
    const kids = node.getChildren(sf);
    if (kids.length === 0) {
      for (const r of ts.getLeadingCommentRanges(src, node.pos) ?? []) cuts.push([r.pos, r.end]);
      for (const r of ts.getTrailingCommentRanges(src, node.end) ?? []) cuts.push([r.pos, r.end]);
      return;
    }
    for (const k of kids) walk(k);
  };
  walk(sf);

  if (cuts.length === 0) return src;

  // ★ A COMMENT THAT OWNS ITS WHOLE LINE TAKES THE LINE WITH IT.
  //
  // Callers bound the DISTANCE between two tokens (`guardedInvokeFetch[\s\S]{0,900}
  // redirect: 'manual'`) so that an explanation written between them cannot turn a
  // security assertion red while the code is unchanged. Cutting only the comment text
  // leaves the indentation and the newline behind, so a 30-line incident note still
  // contributed ~150 characters — and it did: "it re-screens each hop inside the loop"
  // went red on the first version of this function with the loop fully intact. The
  // remedy is not a bigger bound; it is that comment-only lines contribute nothing.
  //
  // A TRAILING comment keeps its line, because that line still holds code.
  const lineStartAt = (i: number): number => src.lastIndexOf('\n', i - 1) + 1;
  const lineEndAt = (i: number): number => {
    const nl = src.indexOf('\n', i);
    return nl === -1 ? src.length : nl + 1;
  };
  const widened = cuts.map(([pos, end]): [number, number] => {
    const ls = lineStartAt(pos);
    const le = lineEndAt(end);
    const before = src.slice(ls, pos);
    const after = src.slice(end, le);
    return before.trim() === '' && after.trim() === '' ? [ls, le] : [pos, end];
  });

  widened.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = '';
  let at = 0;
  for (const [pos, end] of widened) {
    if (end <= at) continue;          // fully inside a cut already taken
    out += src.slice(at, Math.max(pos, at));
    at = Math.max(at, end);
  }
  return out + src.slice(at);
}

/**
 * The fixture every consumer of `stripComments` is checked against.
 *
 * Exported rather than inlined so the relay suite (tsx) and the root suite (vitest) —
 * two runners that never load each other's files — assert against the SAME text. Each
 * entry is a line the old regex stripper mishandled, and `SURVIVOR` is the token that
 * must still be there afterwards.
 */
export const STRIPPER_FIXTURE = [
  "// ── /amep/* — AMEP engine (the phantom opener that ate 174 lines of server.ts)",
  "// CORS (ACAO:*) via the /ns/* public linked-data carve-out.",
  "const accept = { Accept: 'text/turtle, application/trig, */*' };",
  "const notAComment = 'a /* b */ c';",
  "const blockRe = /\\/\\*[\\s\\S]*?\\*\\//g;   // a regex literal spelling /* and */",
  "const url = 'http://127.0.0.1:3000/x';  // a // inside a string literal",
  "/* a real block comment\n   spanning lines */",
  "const SURVIVOR_TOKEN = 'setHeader(Access-Control-Allow-Credentials)';",
  "const division = 10 / 2 / 1;",
].join('\n');

/** What must be TRUE of `stripComments(STRIPPER_FIXTURE)`, as [label, predicate] pairs. */
export const STRIPPER_EXPECTATIONS: ReadonlyArray<readonly [string, (out: string) => boolean]> = [
  ['code after a `//` line containing `/*` SURVIVES', o => o.includes('SURVIVOR_TOKEN')],
  ['a `*/*` string literal does not open a comment', o => o.includes("'text/turtle, application/trig, */*'")],
  ['a `/* */` INSIDE a string literal is not a comment', o => o.includes("'a /* b */ c'")],
  ['a regex literal spelling /* and */ survives', o => o.includes('blockRe = /\\/\\*[\\s\\S]*?\\*\\//g')],
  ['the `//` in a URL string literal survives', o => o.includes("'http://127.0.0.1:3000/x'")],
  ['division is not mistaken for a regex', o => o.includes('10 / 2 / 1')],
  ['a real block comment IS removed', o => !o.includes('a real block comment')],
  ['a real trailing line comment IS removed', o => !o.includes('inside a string literal')],
  ['the `// ── /amep/*` line itself IS removed', o => !o.includes('AMEP engine')],
  // The distance property, stated as a fixture check: four of the ten fixture lines are
  // comment-only, and none of them may survive as a blank line — see the note in
  // stripComments about "it re-screens each hop inside the loop" going red.
  ['comment-only lines leave no blank line behind',
    o => o.split('\n').length === STRIPPER_FIXTURE.split('\n').length - 4],
  ['a line that also holds code KEEPS its line', o => o.includes("const url = 'http://127.0.0.1:3000/x';")],
];
