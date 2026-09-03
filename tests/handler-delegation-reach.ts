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
 * ── ★★ IT FOLLOWED ONE HOP, AND SAYING SO IN A COMMENT DID NOT CLOSE THE HOLE ───────────────
 *
 * This module used to stop at the function a handler DIRECTLY returns, with a stated bound: "a
 * decline built deeper and passed up unchanged is still not covered". The reason given was that
 * going deeper needs real dataflow — a function three calls down may build an `{ error }` its
 * caller inspects and never returns, and reporting that is the false-positive class that makes a
 * gate unreadable.
 *
 * ★ THAT REASON IS TRUE OF CALLS IN GENERAL AND FALSE OF TAIL CALLS, WHICH IS ALL THIS FOLLOWS.
 * The property that makes depth one sound is not the depth. It is that `return f(x)` hands f's
 * value back UNEXAMINED — the caller cannot branch on what it did not look at. That property is
 * transitive: if a handler tail-calls `a`, and `a` tail-calls `b`, then `b`'s return value is the
 * HTTP response by exactly the same construction, one more time. The dataflow objection describes
 * `const r = f(x); if (r.error) …`, which is NOT a tail call — so the walk stops there, which is
 * where the census's own bridge-file leg takes over.
 *
 * So the chain is walked while every hop is a pure tail call, and abandoned the moment one is
 * not. `hops` reports each function whose answer becomes the response, and the census reads all
 * of them. Depth is capped and cycles are tracked, so a mutually-recursive pair cannot hang it.
 */
import ts from 'typescript';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** One function whose return value becomes the handler's, and the module defining it. */
export interface Hop {
  /** The function's name, e.g. `authorTool`. */
  readonly fn: string;
  /** Absolute path of the module that defines it, when it could be resolved. */
  readonly module: string | null;
}

export interface Delegation {
  /** The MCP tool name, e.g. `ac.author_tool`. */
  readonly tool: string;
  /** The function the handler returns the result of, e.g. `authorTool`. */
  readonly fn: string;
  /** Absolute path of the module that defines it, when it could be resolved. */
  readonly module: string | null;
  /**
   * Every function whose answer becomes this handler's answer, nearest first.
   *
   * `hops[0]` is `{ fn, module }` above — the direct delegate — and each later entry is reached
   * because the one before it does nothing but `return thatFunction(…)`. The walk stops at the
   * first hop that examines the value, and at the first module that cannot be resolved.
   */
  readonly hops: readonly Hop[];
}

/** How far a tail-call chain is followed. Measured chains are 1–2 long; this is a hang guard. */
const MAX_HOPS = 8;

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
function tailCallName(fn: { readonly body?: ts.Node }): string | null {
  let expr: ts.Expression | undefined;
  if (!fn.body) return null;
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
  } else if (ts.isExpression(fn.body as ts.Node)) {
    expr = fn.body as ts.Expression;
  } else {
    return null;
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
 * The declaration of `name` in `src`, if it is a function this module can read a tail call from.
 *
 * Both shapes real code uses: `export function name(…) {…}` and `const name = (…) => …`. A
 * re-export (`export { name } from './x.js'`) is not a declaration and returns null, which ends
 * the walk rather than guessing.
 */
function functionNamed(src: ts.SourceFile, name: string): { readonly body?: ts.Node } | null {
  let found: { readonly body?: ts.Node } | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) { found = node; return; }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name
      && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(src, visit);
  return found;
}

/**
 * Walk the tail-call chain from a direct delegate, collecting every function whose answer
 * becomes the response.
 *
 * Each step is only taken when the current function's ENTIRE contribution is `return next(…)`.
 * That is the same property depth one relied on, applied again — see this file's header for why
 * the dataflow objection does not apply to a tail call. A hop whose module cannot be resolved,
 * or whose function is not a tail-call delegator, is the last one.
 */
function walkTailCalls(first: Hop): Hop[] {
  const hops: Hop[] = [first];
  const seen = new Set<string>([`${first.module ?? '?'}|${first.fn}`]);
  let current = first;
  while (hops.length < MAX_HOPS && current.module) {
    const src = ts.createSourceFile(
      current.module, readFileSync(current.module, 'utf8'), ts.ScriptTarget.Latest, true);
    const decl = functionNamed(src, current.fn);
    if (!decl) break;
    const next = tailCallName(decl);
    if (!next) break;
    // Imported from elsewhere, or defined in this same module.
    const spec = importMap(src).get(next);
    const module = spec ? resolveLocal(current.module, spec) : current.module;
    // ★ A METHOD CALL IS NOT A DELEGATION. `tailCallName` reports the property for `x.f(…)`,
    // which is right for `mod.fn(…)` and wrong for `values.sort(…)` — and measured: it produced
    // a phantom hop `estimateConceptDifficulty -> sort`. Requiring the name to be imported or
    // declared in the module tells the two apart without a list of method names to maintain.
    if (!spec && !functionNamed(src, next)) break;
    const key = `${module ?? '?'}|${next}`;
    if (seen.has(key)) break;
    seen.add(key);
    current = { fn: next, module };
    hops.push(current);
  }
  return hops;
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
        const first: Hop = { fn, module: spec ? resolveLocal(file, spec) : null };
        out.push({
          tool: node.name.text,
          fn: first.fn,
          module: first.module,
          hops: walkTailCalls(first),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(src, visit);
  return out;
}
