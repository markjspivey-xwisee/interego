/**
 * AN EXAMPLE OR DEMO INSTALLED ON ITS OWN LINKS THE PACKAGES IT IMPORTS.
 *
 * The packages under `examples/` and `demos/` that carry their own package-lock.json are not
 * root workspaces: their READMEs say `cd examples/<name> && npm install`, a standalone install.
 * Five of them declared `"@interego/core": "file:../../"`, from when the repository root WAS that
 * package. The root is `@interego/workspace` now, with no entry point, so that install linked
 * core to the root. tsc still compiled (it falls back to an ancestor node_modules), and the
 * personal-bridge then died at startup with ERR_MODULE_NOT_FOUND (2026-09-28). They also imported
 * workspace packages they never declared, and two lockfiles still named the package
 * `@foxxi/context-graphs`, so `npm ci` refused them.
 *
 * It lives here, not in `tests/`, because it reads `examples/` and `demos/`, which the base runs
 * without (tools/base-without-verticals.mjs).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
interface Lockfile {
  packages: Record<string, PackageJson & { link?: boolean; resolved?: string }>;
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const tracked = (...pathspecs: string[]): string[] =>
  execFileSync('git', ['ls-files', '-z', ...pathspecs], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);

/** Every package under examples/ or demos/ with its own lockfile: `npm install` there stands alone. */
const STANDALONE = tracked(':(glob)examples/*/package-lock.json', ':(glob)demos/*/package-lock.json')
  .map(dirname)
  .filter(dir => existsSync(join(ROOT, dir, 'package.json')));

const interegoDeps = (pkg: PackageJson): Array<[string, string]> =>
  Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([name]) => name.startsWith('@interego/'));

/** The @interego packages a package's own tracked sources import, statically or dynamically. */
const importedInteregoPackages = (dir: string): Set<string> => {
  const names = new Set<string>();
  const sources = tracked(`:(glob)${dir}/**/*.ts`, `:(glob)${dir}/**/*.mts`, `:(glob)${dir}/**/*.tsx`)
    .filter(file => !/\/(node_modules|dist)\//.test(file));
  for (const file of sources) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const m of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"](@interego\/[a-z0-9-]+)['"/]/g)) {
      if (m[1]) names.add(m[1]);
    }
  }
  return names;
};

describe('examples and demos installed on their own', () => {
  it('are found, so an empty glob cannot pass the checks below', () => {
    expect(STANDALONE).toEqual(expect.arrayContaining([
      'demos/interego-bridge',
      'examples/dashboard',
      'examples/multi-agent',
      'examples/personal-bridge',
      'examples/pgsl-browser',
    ]));
  });

  it.each(STANDALONE)('%s links every @interego package it declares to that package', dir => {
    const pkg = readJson<PackageJson>(join(ROOT, dir, 'package.json'));
    for (const [name, spec] of interegoDeps(pkg)) {
      // Outside a workspace install, `*` or a version range would go to the npm registry.
      expect(spec, `${dir}: ${name}`).toMatch(/^file:/);
      const target = join(ROOT, dir, spec.slice('file:'.length), 'package.json');
      const actual = existsSync(target) ? readJson<PackageJson>(target).name : '(no package.json there)';
      expect(actual, `${dir}: ${name} is ${spec}`).toBe(name);
    }
  });

  it.each(STANDALONE)('%s declares every @interego package its sources import', dir => {
    const declared = new Set(interegoDeps(readJson<PackageJson>(join(ROOT, dir, 'package.json'))).map(([name]) => name));
    expect([...importedInteregoPackages(dir)].filter(name => !declared.has(name)), dir).toEqual([]);
  });

  it.each(STANDALONE)('%s has a lockfile npm ci accepts: the same declarations and the same links', dir => {
    const pkg = readJson<PackageJson>(join(ROOT, dir, 'package.json'));
    const lock = readJson<Lockfile>(join(ROOT, dir, 'package-lock.json'));
    const root = lock.packages[''] ?? {};
    expect(root.dependencies ?? {}, `${dir} dependencies`).toEqual(pkg.dependencies ?? {});
    expect(root.devDependencies ?? {}, `${dir} devDependencies`).toEqual(pkg.devDependencies ?? {});
    for (const [name, spec] of interegoDeps(pkg)) {
      expect(lock.packages[`node_modules/${name}`], `${dir}: ${name}`)
        .toMatchObject({ link: true, resolved: spec.slice('file:'.length).replace(/\/$/, '') });
    }
  });
});
