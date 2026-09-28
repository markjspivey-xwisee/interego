/**
 * The dashboard runs in a browser, so nothing it loads may reach for what only Node has.
 *
 * ★ WHY THIS FILE EXISTS. The dashboard imports some of this vertical's own modules (the report
 * model, the Markdown renderer, the answer checks), and one of them, reached through the report
 * model, read `process.env` as it loaded. In a browser there is no `process`, so the whole app
 * threw before it drew anything: a blank page since #80, which no test saw, because vitest runs
 * in Node and CI does not build the dashboard.
 *
 * ★ IT IS RUN, NOT SEARCHED. The dashboard is bundled as a browser bundler takes it, its npm
 * packages left out, and every module in it is loaded in a sandbox that has what a browser has
 * when a page loads and none of Node's globals: no `process`, `Buffer` or `require`. The npm
 * packages are stand-ins that answer anything. A module that reads its environment only where one
 * exists (`typeof process !== 'undefined'`) loads; one that names `process` regardless throws, as
 * it did in the browser. Nothing it loads may ask for a Node module either.
 */
import { describe, expect, it } from 'vitest';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';

/** Anything an npm package or the page would hand back: callable, constructible, every property itself. */
const standIn: unknown = new Proxy(function standIn() { /* anything */ }, {
  get: (_target, key) => (key === 'then' ? undefined : key === Symbol.toPrimitive ? () => '' : standIn),
  apply: () => standIn,
  construct: () => standIn as object,
});

async function dashboardBundle(): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../dashboard-app/src/main.tsx', import.meta.url))],
    bundle: true, write: false, platform: 'browser', format: 'cjs', packages: 'external',
    jsx: 'automatic', logLevel: 'silent',
    // What Vite puts in import.meta.env: nothing set, so every module takes its default.
    define: { 'import.meta.env': '{}' },
  });
  return result.outputFiles.map(f => f.text).join('\n');
}

describe('the dashboard, loaded as a browser loads it', () => {
  it('loads every module with no Node global and no Node module', async () => {
    const code = await dashboardBundle();
    expect(code.length).toBeGreaterThan(10_000);   // the app itself, not an empty bundle
    const asked: string[] = [];
    const browser = {
      window: standIn, document: standIn, navigator: standIn, location: standIn, history: standIn,
      localStorage: standIn, sessionStorage: standIn, fetch: standIn,
      setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
      TextEncoder, TextDecoder, URL, URLSearchParams, atob, btoa, crypto: globalThis.crypto, console,
      module: { exports: {} as unknown }, exports: {},
      require: (id: string) => {
        asked.push(id);
        if (id.startsWith('node:') || builtinModules.includes(id)) throw new Error(`a browser has no Node module ${id}`);
        return standIn;
      },
    };
    browser.module.exports = browser.exports;
    expect(() => runInNewContext(code, browser, { filename: 'dashboard.bundle.js' })).not.toThrow();
    // What it leaves to the browser's bundler: the dashboard's own npm packages, nothing else.
    expect([...new Set(asked.map(p => p.split('/')[0]!))].sort()).toEqual(['d3-force', 'ethers', 'react', 'react-dom', 'react-router-dom']);
  });

  it('would have caught the blank page: a module that names process as it loads throws here', () => {
    expect(() => runInNewContext('const base = process.env.FOXXI_COURSE_ID_BASE;', { console })).toThrow(/process is not defined/);
    expect(() => runInNewContext("const base = typeof process !== 'undefined' ? process.env.FOXXI_COURSE_ID_BASE : undefined;", { console })).not.toThrow();
  });
});

/**
 * ★ AND IT BUILDS IN ITS IMAGE. deploy/Dockerfile.foxxi-dashboard copies this vertical's src/,
 * reports-ui/ and dashboard-app/, installs each one's own package.json (the vertical's is
 * `ethers` alone), and runs the dashboard's `tsc -b`. The substrate's packages are not there. tsc
 * follows every import, `import type` included, where a bundler (above) drops the type-only ones:
 * the dashboard reached xapi-validate.ts for a duration check, whose model imports the ontology's
 * types from @interego/core, and every image build failed, and every deploy with it, from #535 to
 * this. So the modules tsc reads are walked here, and each may import only what its own image
 * directory installs.
 */
const VERTICAL = fileURLToPath(new URL('..', import.meta.url));
const DASHBOARD_SRC = join(VERTICAL, 'dashboard-app', 'src');
const packageNames = (dir: string): Set<string> => {
  const p = JSON.parse(readFileSync(join(VERTICAL, dir, 'package.json'), 'utf8')) as { dependencies?: object; devDependencies?: object };
  return new Set([...Object.keys(p.dependencies ?? {}), ...Object.keys(p.devDependencies ?? {})]);
};
/** What each directory the image installs can resolve, its own package.json's packages. */
const INSTALLED: ReadonlyArray<[string, Set<string>]> = [
  [join(VERTICAL, 'dashboard-app') + sep, packageNames('dashboard-app')],
  [join(VERTICAL, 'reports-ui') + sep, packageNames('reports-ui')],
  [VERTICAL, packageNames('.')],
];
const packageOf = (specifier: string): string => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');

/** A relative import's file, as tsc resolves it: `.js` names the `.ts`/`.tsx` beside it; a folder, its index. */
function localModule(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  const stem = base.replace(/\.(m?js|jsx)$/, '');
  for (const f of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(f) && statSync(f).isFile()) return f;
  }
  return null;
}

/** Every module tsc reads from these roots, through every import, and the packages each imports. */
function typeCheckedModules(roots: readonly string[]): Map<string, string[]> {
  const read = new Map<string, string[]>();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.pop()!;
    if (read.has(file) || !/\.(tsx?|mts)$/.test(file)) continue;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const packages: string[] = [];
    const visit = (node: ts.Node): void => {
      let specifier: string | undefined;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifier = node.moduleSpecifier.text;
      else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifier = node.arguments[0].text;
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) specifier = node.argument.literal.text;
      if (specifier !== undefined) {
        if (specifier.startsWith('.')) { const next = localModule(file, specifier); if (next) queue.push(next); }
        else packages.push(specifier);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    read.set(file, packages);
  }
  return read;
}

/** What a module imports that the image does not install where it sits: none, for the image to build. */
function uninstalled(modules: Map<string, string[]>): string[] {
  const out: string[] = [];
  for (const [file, packages] of modules) {
    const installed = INSTALLED.find(([dir]) => file.startsWith(dir))?.[1];
    for (const specifier of packages) {
      if (!installed?.has(packageOf(specifier))) out.push(`${relative(VERTICAL, file)} imports ${specifier}`);
    }
  }
  return out;
}

const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));

describe('the dashboard, type-checked as its image checks it', () => {
  it('reads no module that imports a package its image does not install, not even for a type', () => {
    const modules = typeCheckedModules(filesUnder(DASHBOARD_SRC));
    // It walks into the vertical's own modules the dashboard shares, not only its own.
    const shared = [...modules.keys()].filter(f => !f.startsWith(join(VERTICAL, 'dashboard-app'))).map(f => relative(VERTICAL, f).split(sep).join('/'));
    expect(shared).toEqual(expect.arrayContaining(['src/xapi-duration.ts', 'src/session-key.ts', 'src/course-markdown.ts', 'src/work-step-limits.ts']));
    expect(uninstalled(modules)).toEqual([]);
  });

  it('would have caught the image that stopped building: the validator reaches the substrate through a type', () => {
    const modules = typeCheckedModules([join(VERTICAL, 'src', 'xapi-validate.ts')]);
    expect(uninstalled(modules)).toEqual(expect.arrayContaining([expect.stringMatching(/imports @interego\/core$/)]));
  });
});
