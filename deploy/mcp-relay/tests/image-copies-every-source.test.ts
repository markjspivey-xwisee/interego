#!/usr/bin/env tsx
/**
 * Every source the relay actually compiles is in the image.
 *
 * ★ WHY. deploy/Dockerfile.relay does not copy a directory — it lists source files ONE
 * BY ONE (23 of them). Add a module, import it, and everything local is green: tsc
 * passes, the tests pass, CI passes. The file is simply absent from the image.
 *
 * That trap fired on the very PR that introduced oauth-router.ts, with the failure mode
 * already written down in this repo's notes beforehand. It surfaced as a build error
 * only because the relay is tsc-compiled:
 *
 *   server.ts(59,37): error TS2307: Cannot find module './oauth-router.js'
 *
 * A tsx-run service (every vertical bridge) would instead have started, served traffic,
 * and thrown at the first request touching that import.
 *
 * So this walks the ACTUAL import graph from server.ts and asserts every reachable
 * relay module is copied. It is deliberately graph-based rather than a directory
 * listing: test files and unimported modules are correctly absent from the image, and a
 * check that demanded every .ts file would cry wolf until someone deleted it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const relayDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = readFileSync(resolve(relayDir, '..', 'Dockerfile.relay'), 'utf8');

let failures = 0;
const ok = (cond: boolean, name: string, detail = ''): void => {
  if (cond) { console.log(`  PASS  ${name}`); return; }
  failures++; console.error(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`);
};

/** Walk relative imports from server.ts — the image's real entry point. */
const reachable = new Set<string>();
const walk = (file: string): void => {
  if (reachable.has(file)) return;
  reachable.add(file);
  const src = readFileSync(join(relayDir, file), 'utf8');
  // Relative specifiers only: bare specifiers come from node_modules, which the image
  // installs from package.json rather than copying.
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.\/[^'"]+)['"]/g)) {
    const spec = m[1]!;
    // TypeScript ESM imports name the EMITTED .js; the source is .ts.
    const candidate = spec.replace(/^\.\//, '').replace(/\.js$/, '.ts');
    if (existsSync(join(relayDir, candidate))) walk(candidate);
  }
};
walk('server.ts');

console.log('\nDockerfile.relay copies every source the image compiles');

/**
 * Is this file covered by the Dockerfile — either by its own COPY line, or by a
 * directory COPY of an ancestor?
 *
 * Both forms are in use: sources are listed individually, while the vendored AMEP
 * validator is copied as a whole directory. A check that only understood file copies
 * would report `amep-vendor/validator.mjs` missing when it is present — which it did on
 * first run, and which is exactly the kind of false alarm that gets a guard deleted.
 */
const copiedByDockerfile = (file: string): boolean => {
  if (dockerfile.includes(`COPY deploy/mcp-relay/${file}`)) return true;
  const parts = file.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    if (dockerfile.includes(`COPY deploy/mcp-relay/${dir}/`)) return true;
  }
  return false;
};

const missing = [...reachable].filter(f => !copiedByDockerfile(f));
ok(missing.length === 0,
  `all ${reachable.size} modules reachable from server.ts are in the COPY list`,
  missing.length ? `MISSING: ${missing.join(', ')}` : '');

// The vendored AMEP validator is loaded by PATH at runtime rather than imported, so the
// import walk cannot see it. Pinned separately because a missing directory there is a
// runtime failure with no build-time signal at all.
ok(/COPY deploy\/mcp-relay\/amep-vendor\//.test(dockerfile),
  'the AMEP vendor directory is copied (loaded by path, so no import reveals it)');
ok(/cp -r amep-vendor dist\/amep-vendor/.test(dockerfile),
  '…and relocated next to the compiled output, where amep.ts resolves it');

// If the build stopped compiling, a missing file would stop being a build error and
// start being a production runtime error — the bridges' failure mode.
ok(/RUN npx tsc/.test(dockerfile),
  'the image still COMPILES, so a missing module fails the build rather than a request');

console.log(failures === 0
  ? `\n${'-'.repeat(60)}\nEvery compiled source is in the image.\n`
  : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
