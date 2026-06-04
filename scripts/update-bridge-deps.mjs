#!/usr/bin/env node
/**
 * For each bridge / package directory, scan its TS source for
 * `from '@interego/*'` imports and update the package.json's
 * dependencies block to include each one as `"*"`.
 *
 * Idempotent. Only touches dependencies that match `@interego/...`.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: update-bridge-deps.mjs <package.json> [<package.json> ...]');
  process.exit(2);
}

// For each arg of form `pkg.json[:scanRoot]`, find the package root dir.
for (const rawArg of args) {
  const [pkgPath, explicitScan] = rawArg.split('::');
  const abs = resolve(pkgPath);
  const root = dirname(abs);
  const text = await readFile(abs, 'utf8');
  const pkg = JSON.parse(text);

  // Walk the source dir of root and collect @interego/* imports.
  // Bridges include parent-vertical `src/` and `_shared/` paths via their
  // tsconfig. Caller can pass an alternate scan root with `::scanRoot`.
  const found = new Set();
  const scanRoot = explicitScan ? resolve(explicitScan) : root;
  // Use git-grep so we don't pull node_modules.
  let out;
  try {
    out = execSync(
      `git grep -h "from ['\\\"]@interego/" -- "${relative(process.cwd(), scanRoot).replace(/\\/g, '/')}"`,
      { cwd: process.cwd(), encoding: 'utf8' },
    );
  } catch {
    out = '';
  }
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/from\s+['"](@interego\/[^'"\/]+)(?:\/[^'"]*)?['"]/);
    if (m) found.add(m[1]);
  }

  // Skip self-references.
  found.delete(pkg.name);

  // Update deps.
  pkg.dependencies = pkg.dependencies || {};
  let changed = false;
  // Keep existing non-@interego deps; remove stale @interego deps not in `found`
  // EXCEPT keep them if they were declared (e.g. transitive shim during the
  // transition we still want recorded).
  const existing = new Set(Object.keys(pkg.dependencies).filter(k => k.startsWith('@interego/')));
  for (const f of found) {
    if (pkg.dependencies[f] !== '*') {
      pkg.dependencies[f] = '*';
      changed = true;
    }
  }

  if (changed) {
    // Sort deps for stable output: keep insertion-ish order — alpha-sort all deps.
    const sorted = {};
    for (const k of Object.keys(pkg.dependencies).sort()) sorted[k] = pkg.dependencies[k];
    pkg.dependencies = sorted;
    await writeFile(abs, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    console.log(`updated ${abs} → ${[...found].join(', ')}`);
  } else {
    console.log(`no change ${abs}`);
  }
}
