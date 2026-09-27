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
import { build } from 'esbuild';

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
