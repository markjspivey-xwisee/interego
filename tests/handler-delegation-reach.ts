/**
 * WHERE A HANDLER'S ANSWER IS ACTUALLY BUILT.
 *
 * ── WHY A CENSUS OF `bridge/**` IS NOT A CENSUS OF THE HANDLERS ──────────────
 *
 * `createVerticalBridge` derives the HTTP status from the object a handler RETURNS, so an
 * untyped decline is only a defect where that object is constructed. In most verticals it is
 * not constructed in the bridge at all — the handler map is a wall of thin delegators:
 *
 *     'ac.author_tool': async (args) => authorTool({ … }, ctx(args)),
 *
 * `authorTool` lives in `src/`, and its return value IS the handler's return value. A census
 * that reads `bridge/server.ts` therefore reads the argument marshalling and none of the
 * answers. Measured: `agent-collective/bridge/server.ts` contains ONE return object literal,
 * and every decision that file exposes is made somewhere else.
 *
 * This module names the functions a handler hands its answer to, so the census can follow.
 *
 * ── DEPTH ONE, ON PURPOSE ───────────────────────────────────────────────────
 *
 * Only the function a handler DIRECTLY returns is followed. Going deeper would need real
 * dataflow: a function three calls down may build a `{ error }` that its caller inspects and
 * never returns, and reporting that is a false positive of exactly the kind that makes a gate
 * unreadable. Depth one is where "this value becomes the HTTP response" is true by
 * construction — the handler returns it, the dispatcher reads it.
 *
 * That is a real bound and it is stated rather than implied: a decline built deeper and passed
 * up unchanged is still not covered. The gate's own leg says so in its name.
 */
import ts from 'typescript';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface Delegation {
  /** The MCP tool name, e.g. `ac.author_tool`. */
  readonly tool: string;
  /** The function the handler returns the result of, e.g. `authorTool`. */
  readonly fn: string;
  /** Absolute path of the module that defines it, when it could be resolved. */
  readonly module: string | null;
}

/** `./x.js` → the `.ts` file next to `from`, or null when it is not a local module. */
function resolveLocal(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec.replace(/\.js$/, ''));
  for (const cand of [`${base}.ts`, `${base}.mts`, `${base}/index.ts`]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/** name → module specifier, for every named import in a file. */
function importMap(src: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const st of src.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const named = st.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) out.set(el.name.text, st.moduleSpecifier.text);
    }
    if (st.importClause?.name) out.set(st.importClause.name.text, st.moduleSpecifier.text);
  }
  return out;
}

/**
 * The single call a function body hands straight back, if that is all it does.
 *
 * Accepts the concise arrow form (`async (a) => fn(x)`) and the one-statement block form
 * (`async (a) => { return fn(x); }`), including an `await` in front. Anything else — a body
 * that branches, or that builds an object around the call — returns null, because then the
 * bridge file IS where the answer is shaped and the existing census already reads it.
 */
function tailCallName(fn: ts.ArrowFunction | ts.FunctionExpression): string | null {
  let expr: ts.Expression | undefined;
  if (ts.isBlock(fn.body)) {
    const stmts = fn.body.statements;
    const last = stmts[stmts.length - 1];
    if (!last || !ts.isReturnStatement(last) || !last.expression) return null;
    // ★★ EARLIER STATEMENTS DO NOT DISQUALIFY THE TAIL CALL. This required the body to be a
    // SINGLE statement, reasoning that "an earlier statement can decline" — which is true and
    // irrelevant: those earlier declines are written in the bridge file, which the census leg
    // beside this one already reads. What the restriction actually did was skip every handler
    // that checks authorization first and THEN delegates, which is the common shape — and that
    // is precisely where the four untyped declines an audit found were hiding:
    //
    //   foxxi.upload_scorm_package  -> uploadScormPackage()      3 declines, all 200
    //   foxxi.explore_concept_map   -> buildConceptNavGraph()    1 decline, 200
    //   foxxi.scorm_cloud_register  -> createScormCloudRegistration()
    //   foxxi.push_to_cass          -> pushFrameworkToCass()
    //
    // Each types its own decline in the handler and then returns the delegate's answer
    // verbatim, so the delegate's return IS the HTTP response — exactly the case this module
    // exists to follow, and exactly the case it declined to follow.
    expr = last.expression;
  } else {
    expr = fn.body;
  }
  while (expr && ts.isAwaitExpression(expr)) expr = expr.expression;
  if (!expr || !ts.isCallExpression(expr)) return null;
  const callee = expr.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  // `mod.fn(...)` — the name is the property, and the module is not resolvable this way.
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text;
  return null;
}

/**
 * Read a bridge file and report which function each handler delegates its answer to.
 *
 * Handlers are recognised by the shape the dispatcher requires — a property whose key is a
 * string literal containing a dot (`'ac.author_tool'`) and whose value is a function. That is
 * the same discriminator `returnObjects` uses to label an enclosing HANDLER, so the two agree
 * about what a handler is rather than each deciding separately.
 */
export function delegationsIn(file: string): Delegation[] {
  const text = readFileSync(file, 'utf8');
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports = importMap(src);
  const out: Delegation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)
      && (ts.isStringLiteral(node.name) || ts.isNoSubstitutionTemplateLiteral(node.name))
      && node.name.text.includes('.')
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      const fn = tailCallName(node.initializer);
      if (fn) {
        const spec = imports.get(fn);
        out.push({
          tool: node.name.text,
          fn,
          module: spec ? resolveLocal(file, spec) : null,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(src, visit);
  return out;
}
