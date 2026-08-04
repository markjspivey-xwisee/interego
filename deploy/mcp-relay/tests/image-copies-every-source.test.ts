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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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

/**
 * ★ AND NOTHING LIVES OUTSIDE THE GRAPH.
 *
 * The walk above is only as good as its starting point. The header of this file calls an
 * unimported module "correctly absent from the image" — true of the image, and false of
 * everything else. tsconfig.json builds the relay's tsc program the same way: an
 * `include` list of roots, plus whatever those roots import. So the one property that
 * excuses a file from the COPY list also excuses it from the COMPILER.
 *
 * deploy/mcp-relay/subscription-client.ts sat here from April to August in no import
 * graph, no COPY line and no test script — and `npx tsc --noEmit -p . --listFiles` never
 * once mentioned it. Nothing compiled it, so nothing could report that it had rotted,
 * while its header advertised a live Solid Notifications subscription whose only named
 * consumer logs "stub — wire real subscription client in follow-up". It was deleted;
 * this check is what makes the next one visible on the commit that adds it.
 *
 * So every root-level .ts must be ACCOUNTED FOR: reachable from server.ts (and therefore
 * COPY-checked above), run by an npm script, or a tool config the tool loads by filename.
 * That is this repo's "register it in BOTH places" rule stated as a check. It is NOT
 * "every .ts must be COPY'd" — the header above explains why that one would cry wolf.
 */
const TOOL_CONFIGS = new Set([
  // Playwright resolves this by filename convention: no import reaches it and no script
  // names it, yet `npm run test:e2e` is broken without it.
  'playwright.config.ts',
]);
{
  const scripts = Object.values(
    (JSON.parse(readFileSync(join(relayDir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    }).scripts ?? {},
  ).join(' ');
  // Whole-token match, not `includes`: a plain substring test would let a new orphan named
  // `view-test.ts` pass on the strength of `_note-view-test.ts` already being in the script.
  const runByScript = (f: string): boolean =>
    new RegExp(`(^|[\\s/])${f.replace(/\./g, '\\.')}(\\s|$)`).test(scripts);

  // Root level only, and non-recursive: `tests/` holds fixtures that are imported by test
  // files or launched by a GitHub workflow rather than an npm script (tck-sut.ts,
  // listen-loopback.ts, passkey-oauth.spec.ts). Reaching into it would cry wolf on all three.
  const orphans = readdirSync(relayDir)
    .filter(f => f.endsWith('.ts'))
    .filter(f => !reachable.has(f) && !runByScript(f) && !TOOL_CONFIGS.has(f));

  ok(orphans.length === 0,
    'every root-level relay .ts is reachable from server.ts, run by a script, or a tool config',
    orphans.length
      ? `ORPHANED — in no import graph, so in no image, no tsc program and no test: ${orphans.join(', ')}`
      : '');
}

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

// ── every @interego/* dependency is BUILT and INSTALLED in the image ──────
//
// ★ The COPY walk above only sees relay .ts files. A new WORKSPACE dependency is a
// different failure: the manifest declares it, local `npm install` symlinks it from the
// monorepo so everything is green, and the image — which strips all @interego/* deps
// and reinstalls them from tarballs — simply does not have it. That is a runtime
// ERR_MODULE_NOT_FOUND on the first request that touches the import, and this class
// already cost one deploy.
//
// Two lists must agree with the manifest: the `for pkg in …` pack loop that BUILDS the
// tarballs, and the `npm install /tarballs/…` list that INSTALLS them. Transitive
// @interego deps count too — installing a tarball whose own @interego dep is absent
// makes npm reach for a registry package that does not exist.
{
  const relayPkg = JSON.parse(readFileSync(join(relayDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const pkgVersion = (name: string): string | null => {
    const p = resolve(relayDir, '..', '..', 'packages', name, 'package.json');
    if (!existsSync(p)) return null;
    return (JSON.parse(readFileSync(p, 'utf8')) as { version: string }).version;
  };

  // Close over transitive @interego/* deps, since a tarball drags its own in.
  const needed = new Set<string>();
  const visit = (name: string): void => {
    if (needed.has(name)) return;
    needed.add(name);
    const p = resolve(relayDir, '..', '..', 'packages', name, 'package.json');
    if (!existsSync(p)) return;
    const deps = (JSON.parse(readFileSync(p, 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {};
    for (const d of Object.keys(deps)) {
      if (d.startsWith('@interego/')) visit(d.slice('@interego/'.length));
    }
  };
  for (const d of Object.keys(relayPkg.dependencies ?? {})) {
    if (d.startsWith('@interego/')) visit(d.slice('@interego/'.length));
  }

  const packLoop = dockerfile.match(/for pkg in ([^;]+);/)?.[1] ?? '';
  const packed = new Set(packLoop.trim().split(/\s+/));

  const missingFromPack: string[] = [];
  const missingFromInstall: string[] = [];
  for (const name of needed) {
    const version = pkgVersion(name);
    if (version === null) continue;               // not a workspace package
    // `core` is copied explicitly rather than via the loop; accept either.
    if (!packed.has(name) && !dockerfile.includes(`packages/${name}`)) missingFromPack.push(name);
    if (!dockerfile.includes(`/tarballs/interego-${name}-${version}.tgz`)) {
      missingFromInstall.push(`interego-${name}-${version}.tgz`);
    }
  }

  ok(missingFromPack.length === 0,
    'every @interego/* dependency (incl. transitive) is BUILT by the pack loop',
    missingFromPack.length ? `MISSING: ${missingFromPack.join(', ')}` : '');
  ok(missingFromInstall.length === 0,
    '…and INSTALLED from a tarball whose name matches the package version',
    missingFromInstall.length ? `MISSING: ${missingFromInstall.join(', ')}` : '');

  // A non-@interego runtime dep loaded by DYNAMIC import is invisible to the build:
  // openPgStore imports 'pg' lazily so the package carries no hard dep, so its absence
  // is a first-request throw rather than a build error.
  if (Object.keys(relayPkg.dependencies ?? {}).includes('pg')) {
    ok(!/delete p\.dependencies\['pg'\]/.test(dockerfile),
      "'pg' survives into the image (openPgStore dynamic-imports it, so a miss is a runtime throw)");
  }
}

console.log(failures === 0
  ? `\n${'-'.repeat(60)}\nEvery compiled source is in the image.\n`
  : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
