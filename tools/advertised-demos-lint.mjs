#!/usr/bin/env node
/**
 * The multi-agent scripts the docs tell people to run are the ones CI compiles.
 *
 * The README advertises `npx tsx examples/multi-agent/<demo>.ts`, and tsx never typechecks, so
 * `.github/workflows/bridge-typecheck.yml` compiles examples/multi-agent/tsconfig.advertised.json
 * (#567). This keeps that file's list equal to every such instruction in the tracked Markdown,
 * plus the example's own `npm start`.
 *
 * ★ WHY A LINT STEP AND NOT ONLY A TEST (Codex, on #567). The scan reads every tracked Markdown
 * file, and the only workflow that runs the root suite is path-filtered. A pull request that
 * advertised a new demo in, say, quickstart/README.md would never start that workflow, so neither
 * this check nor the compile would run. lint.yml runs on every pull request, unfiltered.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEMO_DIR = 'examples/multi-agent';
export const ADVERTISED_TSCONFIG = `${DEMO_DIR}/tsconfig.advertised.json`;

const INSTRUCTION = /\btsx\s+examples\/multi-agent\/([a-z0-9-]+\.ts)\b/g;

/** Every `tsx examples/multi-agent/<script>.ts` instruction in the tracked Markdown. */
export function advertisedDemos(root = ROOT) {
  const docs = execFileSync('git', ['ls-files', '-z', ':(glob)**/*.md'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean);
  const names = new Set();
  for (const doc of docs) {
    for (const m of readFileSync(join(root, doc), 'utf8').matchAll(INSTRUCTION)) names.add(m[1]);
  }
  return names;
}

/** The script the example's own `npm start` runs, if it runs one with tsx. */
export function startScript(root = ROOT) {
  const start = JSON.parse(readFileSync(join(root, DEMO_DIR, 'package.json'), 'utf8')).scripts?.start ?? '';
  return /\btsx\s+([a-z0-9-]+\.ts)\b/.exec(start)?.[1];
}

/** What CI compiles. */
export function compiledDemos(root = ROOT) {
  return JSON.parse(readFileSync(join(root, ADVERTISED_TSCONFIG), 'utf8')).files ?? [];
}

/** Every mismatch; empty when CI compiles exactly the advertised scripts plus `npm start`. */
export function judge(root = ROOT) {
  const expected = advertisedDemos(root);
  const start = startScript(root);
  if (start) expected.add(start);
  const compiled = new Set(compiledDemos(root));
  const problems = [];
  if (expected.size === 0) problems.push('no advertised multi-agent script was found, so the scan matched nothing');
  for (const name of expected) {
    if (!compiled.has(name)) problems.push(`${DEMO_DIR}/${name} is advertised or run by npm start, but ${ADVERTISED_TSCONFIG} does not compile it`);
  }
  for (const name of compiled) {
    if (!expected.has(name)) problems.push(`${ADVERTISED_TSCONFIG} compiles ${name}, which no doc advertises and npm start does not run`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const problems = judge();
  if (problems.length > 0) {
    for (const p of problems) console.error(`★ ${p}`);
    process.exit(1);
  }
  console.log(`PASS: ${ADVERTISED_TSCONFIG} compiles exactly the ${compiledDemos().length} multi-agent scripts the docs advertise, plus npm start.`);
}
