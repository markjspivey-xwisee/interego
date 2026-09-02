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
 *   · `return ({ … })` and `async (args) => ({ … })` were invisible — 23 sites in the handler
 *     map use the second form.
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
  /** The object literal's source text, verbatim from the file. */
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

function enclosingOf(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isPropertyAssignment(n)) {
      const named = ts.isStringLiteralLike(n.name) ? n.name.text
        : ts.isIdentifier(n.name) ? n.name.text : '';
      const isFn = ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer);
      if (isFn) return HANDLER_KEY.test(named) ? `HANDLER ${named}` : 'callback';
    }
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)
      && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      return n.name.text;
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
export function returnObjects(src: string): ReturnObject[] {
  const sf = ts.createSourceFile('scan.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: ReturnObject[] = [];

  const push = (obj: ts.ObjectLiteralExpression, at: ts.Node, statusCall: number | null, viaVariable: boolean): void => {
    out.push({
      text: obj.getText(sf),
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
