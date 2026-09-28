#!/usr/bin/env node
/**
 * The base, built and tested with every vertical, integration and example removed (#366).
 *
 * ★ WHY PHYSICAL ABSENCE AND NOT AN IMPORT GRAPH ALONE. "The base does not need the verticals" is
 * a claim about what happens when they are not there. An import graph says what a test module
 * names; it does not say what it reads at run time (a source pin reading a vertical's file, a
 * gate walking `applications/`), and it cannot say that the build, the typecheck and the
 * relay's own suite still hold. So CI deletes `applications/`, `integrations/` and `examples/`,
 * and every package under `packages/` that a vertical owns, and runs the base: the base packages
 * build, the relay, stdio, identity and validator services typecheck, identity passes its own
 * tests, the relay its own test scripts, and every root and stdio test module whose closure
 * stays inside the base passes too.
 *
 * ★ WHICH TESTS ARE BASE IS DERIVED, AND THE REST ARE COUNTED. A test module is base when neither
 * it nor any test-side module it imports (under `tests/`, `tools/` or a relay test script) names a
 * path in `applications/`, `integrations/` or `examples/` — by import or by a string that is such
 * a path — and nothing it imports is a package published from them (the neutrality gate's rule).
 * Production modules are not literal-scanned: `tools/base-neutrality-lint.mjs` already holds
 * them to a hard zero. A test that reaches a vertical is an integration test in a base
 * directory; their number is pinned below, so the next domain-heavy fixture goes to the
 * vertical or to `integrations/tests`, where it belongs, rather than into the base's own suite.
 *
 * Usage:
 *   node tools/base-without-verticals.mjs --list    the base set, what was left out and why
 *   node tools/base-without-verticals.mjs --plan    classify (trees present), check the pins, write the plan
 *   node tools/base-without-verticals.mjs --run     CI only: refuses unless the trees are gone and a plan exists
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname, resolve, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { VERTICAL_OWNED, forbiddenPackages, forbiddenReason } from './base-neutrality-lint.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REMOVED = ['applications', 'integrations', 'examples'];
/**
 * Everything the run deletes: the three trees, and every package under `packages/` that belongs to a
 * vertical, so the run shows independence from all of them (Codex, on #563).
 */
export const DELETED = [...REMOVED, ...VERTICAL_OWNED.map(v => v.dir)];

/**
 * The base's own build, as `npm run build --workspace` steps: the root's `build:core` and
 * `build:leaves` workspaces, less the vertical-owned packages the run deletes. Read from the
 * root's scripts, so a package added to the build is built here too.
 */
export function baseBuildWorkspaces() {
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;
  const owned = new Set(VERTICAL_OWNED.map(v => {
    try { return JSON.parse(readFileSync(join(ROOT, v.dir, 'package.json'), 'utf8')).name; } catch { return undefined; }
  }).filter(Boolean));
  return [scripts['build:core'], scripts['build:leaves']].join(' && ')
    .split('&&').map(step => /--workspace\s+(\S+)/.exec(step)?.[1]).filter(Boolean).filter(name => !owned.has(name));
}
const RELAY = 'deploy/mcp-relay';

/**
 * Test modules in base directories that reach a vertical, an integration or an example. They are
 * pinned, not asserted zero: each is a real cross-cutting check (a relay rule read against a
 * vertical's caller, an example's rule pack as a fixture), and moving them is its own work. Growth
 * fails; a pin above the measured count fails as stale.
 */
export const REACHING_PINS = { vitest: 121, relay: 4, program: 4 };

const rel = p => relative(ROOT, p).replace(/\\/g, '/');
/**
 * A string that is a path into one of the removed trees: rooted at the repository (`applications`,
 * `integrations/x`) or climbing to it (`../../examples/y`). Not a URL, whose `/applications/` is
 * part of an identifier, and not `docs/applications/...`, which this run keeps.
 */
const VERTICAL_PATH_LITERAL = /^(?:\.{1,2}[\\/])*(applications|integrations|examples)(?:[\\/]|$)/;
const namesVerticalPath = l => !l.includes('://') && VERTICAL_PATH_LITERAL.test(l);
const verticalPath = r => REMOVED.some(t => r === t || r.startsWith(`${t}/`))
  || VERTICAL_OWNED.some(v => r === v.dir || r.startsWith(`${v.dir}/`));
/** Test-side code: scanned for literal vertical paths as well as imports. */
const testSide = r => /^(tests|tools)\//.test(r) || /(^|\/)tests\//.test(r) || /^deploy\/mcp-relay\/_[^/]*-test\.ts$/.test(r) || /\.test\.m?[jt]s$/.test(r);

function resolveModule(from, spec) {
  const base = resolve(dirname(from), spec);
  const tries = spec.endsWith('.js') ? [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base]
    : spec.endsWith('.mjs') ? [base, base.replace(/\.mjs$/, '.mts')]
      : /\.[cm]?[jt]sx?$/.test(spec) ? [base]
        : [`${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, join(base, 'index.ts')];
  return tries.find(p => existsSync(p) && statSync(p).isFile());
}

function scanModule(file) {
  const text = readFileSync(file, 'utf8');
  const kind = /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const specifiers = [];
  const literals = [];
  const lit = n => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined);
  const visit = node => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.push(node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) literals.push(node.text);
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const s = lit(node.moduleSpecifier); if (s !== undefined) specifiers.push(s);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const s = lit(node.arguments[0]); if (s !== undefined) specifiers.push(s);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const s = lit(node.argument.literal); if (s !== undefined) specifiers.push(s);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { specifiers, literals };
}

/** Why a test module is not base, or undefined when its closure stays inside the base. */
export function reachesVertical(file, packages = forbiddenPackages(ROOT)) {
  const seen = new Set();
  const queue = [resolve(file)];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    const r = rel(current);
    if (verticalPath(r)) return `imports ${r}`;
    const { specifiers, literals } = scanModule(current);
    if (testSide(r)) {
      const named = literals.find(namesVerticalPath);
      if (named !== undefined) return `${r} names ${JSON.stringify(named.slice(0, 80))}`;
      // Enumerating the tracked tree reaches every file in it, the removed trees included.
      if (literals.some(l => /(^|\s)ls-files(\s|$)/.test(l))) return `${r} enumerates the tracked tree (git ls-files), the removed trees included`;
    }
    for (const spec of specifiers) {
      if (spec.startsWith('.')) {
        const target = resolveModule(current, spec);
        if (target && !target.includes(`${join('node_modules')}`)) queue.push(target);
        else if (!target && verticalPath(rel(resolve(dirname(current), spec)))) return `imports ${spec}`;
        continue;
      }
      const why = forbiddenReason(spec, current, ROOT, packages);
      if (why) return `${r} ${why}`;
    }
  }
  return undefined;
}

function filesUnder(dir, pattern) {
  const out = [];
  const walk = d => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (pattern.test(name)) out.push(p);
    }
  };
  walk(join(ROOT, dir));
  return out.sort();
}

/** The relay's own test chain, as the steps its `test` script runs, `npm run` expanded. */
export function relaySteps() {
  const scripts = JSON.parse(readFileSync(join(ROOT, RELAY, 'package.json'), 'utf8')).scripts;
  const steps = [];
  const expand = name => {
    for (const raw of String(scripts[name] ?? '').split('&&')) {
      const step = raw.trim();
      if (!step) continue;
      const npm = /^npm run (\S+)$/.exec(step);
      if (npm) expand(npm[1]); else steps.push(step);
    }
  };
  expand('test');
  return steps;
}

/** Every base test, and every test left out with the reason. */
export function baseTestSet() {
  const packages = forbiddenPackages(ROOT);
  const vitest = [];
  const reachingVitest = [];
  for (const file of [...filesUnder('tests', /\.test\.ts$/), ...filesUnder('mcp-server/tests', /\.test\.ts$/)]) {
    const why = reachesVertical(file, packages);
    if (why) reachingVitest.push({ file: rel(file), why }); else vitest.push(rel(file));
  }
  // The relay's test PROGRAM (tsconfig.tests.json) is wider than the scripts `npm test` runs: it
  // compiles every file under tests/ and every `_*-test.ts`, Playwright specs included. The base
  // run typechecks it without the files that reach a vertical.
  const reachingProgram = [];
  for (const file of [...filesUnder(`${RELAY}/tests`, /\.[cm]?tsx?$/), ...filesUnder(RELAY, /^_.*-test\.ts$/).filter(f => dirname(f) === join(ROOT, RELAY))]) {
    const why = reachesVertical(file, packages);
    if (why) reachingProgram.push({ file: relative(join(ROOT, RELAY), file).replace(/\\/g, '/'), why });
  }
  const relay = [];
  const reachingRelay = [];
  for (const step of relaySteps()) {
    if (step === `tsc --noEmit -p ${RELAY_TESTS_PROGRAM}`) { relay.push(`tsc --noEmit -p ${BASE_RELAY_TESTS_PROGRAM}`); continue; }
    const script = /^(?:tsx|node)\s+(\S+)$/.exec(step)?.[1];
    if (!script) { relay.push(step); continue; }
    const why = reachesVertical(join(ROOT, RELAY, script), packages);
    if (why) reachingRelay.push({ step, why }); else relay.push(step);
  }
  // ★ A TEST THAT RUNS A FILE THAT REACHES A VERTICAL REACHES ONE TOO. The first base run without
  // the trees found `tests/e2e-collection.test.ts`: it imports nothing vertical, but it runs
  // Playwright's collection over `passkey-oauth.spec.ts`, which imports the application runtime,
  // and it names that spec by a string. So a base test whose own strings name a file already
  // classified as reaching is moved out too, until nothing moves.
  const nameOf = f => f.replace(/\\/g, '/').split('/').pop();
  // The scripts a test may run: the second base run found four walkthrough tests that run
  // `tools/walkthrough-v*.ts`, which import `applications/_shared`, naming each by its basename.
  const reachingTools = [...filesUnder('tools', /\.(?:[cm]?[jt]s)$/), ...filesUnder('scripts', /\.(?:[cm]?[jt]s)$/)]
    .filter(f => !f.endsWith('.d.mts') && !f.endsWith('.d.ts') && reachesVertical(f, packages) !== undefined)
    .map(f => nameOf(f));
  for (let moved = true; moved;) {
    moved = false;
    const reachingNames = new Set([...reachingVitest.map(t => nameOf(t.file)), ...reachingProgram.map(t => nameOf(t.file)),
      ...reachingRelay.map(t => nameOf(/^(?:tsx|node)\s+(\S+)$/.exec(t.step)?.[1] ?? '')), ...reachingTools].filter(Boolean));
    const runsReaching = file => scanModule(file).literals.find(l => reachingNames.has(nameOf(l)));
    for (let i = vitest.length - 1; i >= 0; i--) {
      const named = runsReaching(join(ROOT, vitest[i]));
      if (named) { reachingVitest.push({ file: vitest[i], why: `names ${named}, which reaches a vertical` }); vitest.splice(i, 1); moved = true; }
    }
    for (let i = relay.length - 1; i >= 0; i--) {
      const script = /^(?:tsx|node)\s+(\S+)$/.exec(relay[i])?.[1];
      if (!script) continue;
      const named = runsReaching(join(ROOT, RELAY, script));
      if (named) { reachingRelay.push({ step: relay[i], why: `names ${named}, which reaches a vertical` }); relay.splice(i, 1); moved = true; }
    }
  }
  return { vitest, reachingVitest, relay, reachingRelay, reachingProgram };
}

const RELAY_TESTS_PROGRAM = 'tsconfig.tests.json';
/** Written by `--plan` beside it: the same program, without the files that reach a vertical. */
const BASE_RELAY_TESTS_PROGRAM = '.base-without-verticals.tests.tsconfig.json';

/** The pins' verdict on a measured set: empty when both counts are exactly at their pins. */
export function judgeReaching(set, pins = REACHING_PINS) {
  const failures = [];
  const check = (name, found, pinned) => {
    if (found > pinned) failures.push(`${name}: ${found} test(s) in base directories reach a vertical, pinned ${pinned}. A new one belongs in the vertical's tests or integrations/tests.`);
    else if (found < pinned) failures.push(`${name}: ${found} test(s) reach a vertical, below the pin of ${pinned}. Lower the pin.`);
  };
  check('vitest', set.reachingVitest.length, pins.vitest);
  check('relay', set.reachingRelay.length, pins.relay);
  check('relay test program', set.reachingProgram.length, pins.program);
  return failures;
}

export const PLAN_DIR = join(ROOT, '.base-without-verticals');
export const PLAN_FILE = join(PLAN_DIR, 'plan.json');

/**
 * Run one step the way `npm test` would: with the workspace's own `node_modules/.bin` ahead of the
 * rest of PATH, so a bare `tsc` or `tsx` in the relay's chain is this repository's compiler and
 * never whichever one a machine happens to have installed globally.
 */
function run(cmd, args, cwd = ROOT) {
  console.log(`\n$ ${[cmd, ...args].join(' ')}${cwd === ROOT ? '' : `   (in ${rel(cwd)})`}`);
  const bins = [join(cwd, 'node_modules', '.bin'), join(ROOT, 'node_modules', '.bin')];
  const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
  const env = { ...process.env, [pathKey]: [...bins, process.env[pathKey] ?? ''].join(delimiter) };
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: true, env });
  if (r.status !== 0) { console.error(`\n★ BASE WITHOUT VERTICALS FAILED at: ${[cmd, ...args].join(' ')}`); process.exit(1); }
}

function main() {
  const mode = process.argv[2];
  if (mode === '--list' || mode === '--plan') {
    const set = baseTestSet();
    const failures = judgeReaching(set);
    if (mode === '--list') {
      console.log(`base vitest modules: ${set.vitest.length}`);
      console.log(`base relay steps: ${set.relay.length}`);
      console.log(`\nleft out, vitest (${set.reachingVitest.length}, pin ${REACHING_PINS.vitest}):`);
      for (const t of set.reachingVitest) console.log(`  ${t.file} — ${t.why}`);
      console.log(`\nleft out, relay (${set.reachingRelay.length}, pin ${REACHING_PINS.relay}):`);
      for (const t of set.reachingRelay) console.log(`  ${t.step} — ${t.why}`);
      console.log(`left out of the relay's test program (${set.reachingProgram.length}, pin ${REACHING_PINS.program}):`);
      for (const t of set.reachingProgram) console.log(`  ${t.file} — ${t.why}`);
    }
    if (failures.length > 0) { for (const f of failures) console.error(`★ ${f}`); process.exit(1); }
    if (mode === '--plan') {
      // Classified while the trees are still here, so nothing about the classification depends
      // on files the run is about to delete.
      mkdirSync(PLAN_DIR, { recursive: true });
      writeFileSync(PLAN_FILE, JSON.stringify({ build: baseBuildWorkspaces(), vitest: set.vitest, relay: set.relay }, null, 2));
      writeFileSync(join(ROOT, RELAY, BASE_RELAY_TESTS_PROGRAM), JSON.stringify({
        extends: `./${RELAY_TESTS_PROGRAM}`, exclude: ['node_modules', 'dist', ...set.reachingProgram.map(t => t.file)],
      }, null, 2));
      writeFileSync(join(PLAN_DIR, 'tsconfig.json'), JSON.stringify({
        extends: '../tsconfig.check.json', include: [], files: set.vitest.map(f => `../${f}`),
      }, null, 2));
      console.log(`planned: ${set.relay.length} relay steps and ${set.vitest.length} test modules; ${set.reachingVitest.length + set.reachingRelay.length + set.reachingProgram.length} that reach a vertical are left out, at their pins.`);
    }
    return;
  }
  if (mode !== '--run') { console.error('usage: node tools/base-without-verticals.mjs --list | --plan | --run'); process.exit(2); }
  const present = DELETED.filter(t => existsSync(join(ROOT, t)));
  if (present.length > 0) {
    console.error(`★ refusing: ${present.join(', ')} still present. This run proves the base without them; delete them first (CI does: rm -rf ${DELETED.join(' ')}).`);
    process.exit(2);
  }
  if (!existsSync(PLAN_FILE)) { console.error('★ refusing: no plan. Run --plan while the trees are present.'); process.exit(2); }
  const plan = JSON.parse(readFileSync(PLAN_FILE, 'utf8'));
  for (const workspace of plan.build) run('npm', ['run', 'build', '--workspace', workspace]);
  run('npx', ['tsc', '--noEmit', '-p', 'mcp-server/tsconfig.json']);
  // The other base services (spec/LAYERS.md 6.2): identity builds and passes its own tests, and
  // the validator typechecks (Codex, on #563).
  run('npx', ['tsc', '--noEmit', '-p', 'deploy/identity/tsconfig.json']);
  run('npm', ['test', '--workspace', '@interego/identity']);
  run('npx', ['tsc', '--noEmit', '-p', 'deploy/validator/tsconfig.json']);
  for (const step of plan.relay) {
    const [cmd, ...args] = step.split(/\s+/);
    run(cmd, args, join(ROOT, RELAY));
  }
  // The base tests' own typecheck, in place of the full program's (which includes the trees this
  // run deleted): the same compiler options, over exactly the modules this run executes.
  run('npx', ['tsc', '--noEmit', '-p', '.base-without-verticals/tsconfig.json']);
  run('npx', ['vitest', 'run', '-c', 'vitest.base.config.ts']);
  console.log(`\nbase without verticals: built, typechecked, ${plan.relay.length} relay steps and ${plan.vitest.length} test modules green, with ${DELETED.join(', ')} absent.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
