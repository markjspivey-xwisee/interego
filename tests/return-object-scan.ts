/**
 * Find the object literals a module ANSWERS A CALLER WITH, using the TypeScript parser.
 *
 * ── WHY A PARSER, AFTER FIVE REGEXES AND ONE HAND-ROLLED SCANNER ─────────────
 *
 * Three census gates in this repo were regexes, and an audit broke every one: `[^}]*` cannot
 * cross a nested object; a bound at `;` truncates inside a message; a bound at `};` misses
 * `res.status(…).json({…})`; a fixed window both overruns and falls short.
 *
 * So they were replaced by a hand-rolled brace counter that skipped strings, templates and
 * comments. The NEXT audit broke that too, in six ways — and every one is the same mistake
 * again, one level up: recognising JavaScript by hand:
 *
 *   · it had no notion of a REGEX LITERAL, so `.replace(/"/g, '')` inside a refusal either
 *     dropped the literal or overran into the next one. The overrun swallowed a later
 *     `kind: 'refusal'`, which made the census EXCUSE the untyped denial it had just eaten.
 *     Four planted `forbidden` denials passed 7/7. Two such idioms already exist in the bridge.
 *   · `return ({ … })` and `async (args) => ({ … })` were invisible.
 *     ★ THE "23 HANDLER ENTRIES USE THE SECOND FORM" THAT STOOD HERE WAS A MISREAD GREP.
 *     `grep -c "=> ({" foxxi/bridge/server.ts` is 23, but 22 of those are `.map(x => ({…}))`
 *     array callbacks and the 23rd is a local helper; an AST census of handler entries across
 *     every bridge gives 83 block bodies, 34 concise bodies, and ZERO concise bodies that are
 *     object literals. `return ({…})` has no sites either. The forms are still handled — a
 *     parser costs nothing to be complete, and `.map(x => ({…}))` bodies are exactly what the
 *     enclosing-name fix later had to attribute correctly — but the blast radius quoted for
 *     them was a count of something else, which is the measurement error this file is about.
 *   · `res.status([^)]*)` cannot cross a nested paren, so `res.status(Number(400))` lost its
 *     prefix and a correctly-statused route read as un-statused.
 *   · comments were stripped by LINE, so a trailing `// was: return { error: … }` was censused
 *     as a real handler return, and every reported line number was off by the number of
 *     comment lines above it — 1,454 lines off in one case.
 *
 * The lesson is not "write a better matcher". It is that matching a language needs a parser,
 * and this repository already ships one. `typescript` is a devDependency (the vitest typecheck
 * gate runs `tsc`), so the compiler API is here and correct by construction: it knows regex
 * literals from division, template holes from braces, and comments from code — and it reports
 * positions in the ORIGINAL source, so callers no longer pre-strip anything.
 */
import ts from 'typescript';

/** One answer a module hands back: an object literal in return position, or a `.json({…})` arg. */
export interface ReturnObject {
  /**
   * The object literal's source text, with any comments INSIDE it blanked to spaces.
   *
   * ── ★★ WHY NOT VERBATIM ─────────────────────────────────────────────────────────────────────
   *
   * Every caller of this module matches words against this text to decide whether an answer is a
   * decline (`error|reason|refused|denied|…`). A comment explaining a property is part of the
   * literal's source text, so prose landed in the evidence: a return object annotated
   * "Absent from `outputs.required` for the same reason:" was reported as an untyped refusal by
   * `every-vertical-declines-with-a-status`, on a handler that declines nothing.
   *
   * ★★ SECOND INSTANCE OF ONE CLASS, WHICH IS WHY THE FIX IS HERE AND NOT AT THE CALL SITE. The
   * privacy-mode gate asked `code.includes(mode)` and was satisfied by a comment naming the mode
   * above the branch that had been deleted — a false NEGATIVE. `tools/turtle-iri-ratchet.mjs`
   * counted `<${…}>` in prose — a false POSITIVE, and an allowance payable in deleted comments.
   * Both were fixed by asking the parser instead of the text. This is the same fix at the shared
   * layer, so no caller has to remember it, and rewording a comment is never the remedy.
   *
   * Offsets and length are preserved — comments become spaces, newlines survive — so `line`
   * still points where it did and slices still line up with the file.
   */
  readonly text: string;
  /** 1-indexed line in the ORIGINAL source — no stripping, so this is the line you can open. */
  readonly line: number;
  /**
   * The status an Express route sets for this answer: `res.status(403).json({…})` → 403.
   * `null` when there is no `.status()` call in the chain; `NaN` when there is one whose
   * argument is not a numeric literal (`res.status(evidence.status ?? 400)`), which is still a
   * status being set and must not be read as an un-statused answer.
   */
  readonly statusCall: number | null;
  /** `HANDLER <toolName>` | `callback` | `<functionName>` | `(top level)`. */
  readonly enclosing: string;
  /** True when the literal was reached through a variable (`const r = {…}; return r;`). */
  readonly viaVariable: boolean;
}

const HANDLER_KEY = /^[a-z][a-z0-9]*\.[a-z0-9_]+$/i;

/**
 * ★★ STOP AT THE FIRST FUNCTION, NOT THE FIRST NAME.
 *
 * This walked up until it found something NAMED, so a return inside an anonymous callback
 * argument — `endpoints.map(async ep => { … return { ep, statements: [], error: msg }; })` —
 * was attributed to the enclosing `queryFederatedStatements`. It is not that function's answer;
 * it is one row the function aggregates. Measured: four such rows were reported as untyped
 * declines from three files, every one of them ordinary data (a per-endpoint federated result,
 * a `verified: false` verification outcome, two gap records whose `reason` says why something
 * is a GAP rather than why a call was refused).
 *
 * A permanent false positive is as damaging as a false negative, so the walk now stops at the
 * first function-like ancestor and names it only if that function itself is named. Anything
 * anonymous — a call argument, an IIFE — is `callback`, which every census here already
 * excludes.
 */
function enclosingOf(node: ts.Node): string {
  // ★ START AT THE NODE, NOT ITS PARENT. For the `=> ({…})` arrow-body form the node handed in
  // IS the arrow, so starting one level up steps straight over the function that owns the
  // literal — which is how three `.map(s => ({ … reason: … }))` rows were attributed to the
  // named function containing the map, and reported as its untyped declines.
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    // `at` is sometimes the function itself, so its parent is the property assignment and no
    // function node is ever visited. Kept ahead of the function branches for that case.
    if (ts.isPropertyAssignment(n)
      && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      const named = ts.isStringLiteralLike(n.name) ? n.name.text
        : ts.isIdentifier(n.name) ? n.name.text : '';
      return HANDLER_KEY.test(named) ? `HANDLER ${named}` : 'callback';
    }
    if (ts.isFunctionDeclaration(n)) return n.name ? n.name.text : 'callback';
    if (ts.isMethodDeclaration(n)) return ts.isIdentifier(n.name) ? n.name.text : 'callback';
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      const p = n.parent;
      if (p && ts.isPropertyAssignment(p)) {
        const named = ts.isStringLiteralLike(p.name) ? p.name.text
          : ts.isIdentifier(p.name) ? p.name.text : '';
        return HANDLER_KEY.test(named) ? `HANDLER ${named}` : 'callback';
      }
      if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
      // A named function expression (`const f = function g() {}`) still names itself.
      if (ts.isFunctionExpression(n) && n.name) return n.name.text;
      return 'callback';
    }
  }
  return '(top level)';
}

/** Unwrap `(expr)` and `expr as T` / `<T>expr` down to the thing itself. */
function unwrap(e: ts.Expression): ts.Expression {
  let x = e;
  for (;;) {
    if (ts.isParenthesizedExpression(x)) { x = x.expression; continue; }
    if (ts.isAsExpression(x) || ts.isTypeAssertionExpression(x)) { x = x.expression; continue; }
    if (ts.isSatisfiesExpression(x)) { x = x.expression; continue; }
    return x;
  }
}

/**
 * A returned IDENTIFIER resolved to its object literal, when one is declared in an enclosing
 * scope of the same file. A refusal assembled into a `const` and returned by name is the same
 * answer as one written inline; reading only inline literals made those invisible to the
 * status gate's legs.
 */
function resolveIdentifier(id: ts.Identifier, from: ts.Node): ts.ObjectLiteralExpression | null {
  const name = id.text;
  for (let n: ts.Node | undefined = from; n; n = n.parent) {
    let found: ts.ObjectLiteralExpression | null = null;
    ts.forEachChild(n, function visit(child): void {
      if (found) return;
      if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.name.text === name
        && child.initializer) {
        const init = unwrap(child.initializer);
        if (ts.isObjectLiteralExpression(init)) { found = init; return; }
      }
      ts.forEachChild(child, visit);
    });
    if (found) return found;
    if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) break;
  }
  return null;
}

/** The status set by a `res.status(…)` in the same call chain as this `.json(…)`, if any. */
function statusInChain(call: ts.CallExpression): number | null {
  for (let e: ts.Expression = call.expression; ;) {
    if (!ts.isPropertyAccessExpression(e)) return null;
    const target = e.expression;
    if (ts.isCallExpression(target)) {
      const callee = target.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'status') {
        const arg = target.arguments[0];
        if (arg && ts.isNumericLiteral(arg)) return Number(arg.text);
        // A status IS being set; its value just is not a literal here.
        return Number.NaN;
      }
      e = callee;
      continue;
    }
    return null;
  }
}

/**
 * Every object literal this source answers a caller with.
 *
 * Covered: `return {…}`, `return ({…})`, `return x` where x is a local object literal, an
 * arrow body `=> ({…})`, and `.json({…})` (with the status from its own call chain).
 */
/**
 * `node`'s source text with every comment inside it replaced by spaces, same length.
 *
 * The parser is what knows a comment from a `//` in a string or a `/` in a regex — see the note on
 * `ReturnObject.text` for the two gates that got this wrong by asking the text instead. Comments
 * within a literal attach as leading trivia to the token that follows them, so every descendant's
 * trivia is collected; newlines are kept so reported line numbers stay usable.
 */
function textWithoutComments(node: ts.Node, sf: ts.SourceFile): string {
  const full = sf.getFullText();
  const start = node.getStart(sf);
  const chars = full.slice(start, node.getEnd()).split('');
  const blank = (from: number, to: number): void => {
    for (let i = Math.max(from, start); i < Math.min(to, node.getEnd()); i++) {
      const c = chars[i - start];
      if (c !== '\n' && c !== '\r') chars[i - start] = ' ';
    }
  };
  const walk = (n: ts.Node): void => {
    for (const r of ts.getLeadingCommentRanges(full, n.pos) ?? []) blank(r.pos, r.end);
    for (const r of ts.getTrailingCommentRanges(full, n.end) ?? []) blank(r.pos, r.end);
    ts.forEachChild(n, walk);
  };
  walk(node);
  return chars.join('');
}

export function returnObjects(src: string): ReturnObject[] {
  const sf = ts.createSourceFile('scan.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: ReturnObject[] = [];

  const push = (obj: ts.ObjectLiteralExpression, at: ts.Node, statusCall: number | null, viaVariable: boolean): void => {
    out.push({
      text: textWithoutComments(obj, sf),
      line: sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1,
      statusCall,
      enclosing: enclosingOf(at),
      viaVariable,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression) {
      const e = unwrap(node.expression);
      if (ts.isObjectLiteralExpression(e)) push(e, node, null, false);
      else if (ts.isIdentifier(e)) {
        const resolved = resolveIdentifier(e, node);
        if (resolved) push(resolved, node, null, true);
      }
    }
    // An expression-bodied arrow: `async (args) => ({ … })`.
    if ((ts.isArrowFunction(node)) && !ts.isBlock(node.body)) {
      const b = unwrap(node.body);
      if (ts.isObjectLiteralExpression(b)) push(b, node, null, false);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'json') {
      const arg = node.arguments[0];
      if (arg) {
        const a = unwrap(arg);
        if (ts.isObjectLiteralExpression(a)) push(a, node, statusInChain(node), false);
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);
  return out;
}
