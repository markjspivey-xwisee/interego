/**
 * THE MULTI-AGENT SCRIPTS WE TELL PEOPLE TO RUN ARE THE ONES CI COMPILES.
 *
 * The README advertises `npx tsx examples/multi-agent/<demo>.ts`, and tsx never typechecks.
 * Nothing compiled those scripts, so tla-demo.ts and team-demo.ts went on passing `sources` in a
 * provenance facet after the builder had stopped reading it; the field is `wasDerivedFrom`. What
 * they published silently lacked what it was derived from, and only a compiler would have said so
 * (2026-09-28). `.github/workflows/bridge-typecheck.yml` now compiles
 * examples/multi-agent/tsconfig.advertised.json, and this keeps that file's list equal to the
 * scripts the docs tell people to run, plus the example's own `npm start`.
 *
 * It lives here, not in `tests/`, because it reads `examples/`, which the base runs without.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = 'examples/multi-agent';

const tracked = (...pathspecs: string[]): string[] =>
  execFileSync('git', ['ls-files', '-z', ...pathspecs], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as T;

/** Every `tsx examples/multi-agent/<script>.ts` instruction in the tracked docs. */
const advertised = new Set<string>();
for (const doc of tracked(':(glob)**/*.md')) {
  for (const m of readFileSync(join(ROOT, doc), 'utf8').matchAll(/\btsx\s+examples\/multi-agent\/([a-z0-9-]+\.ts)\b/g)) {
    if (m[1]) advertised.add(m[1]);
  }
}
const start = /\btsx\s+([a-z0-9-]+\.ts)\b/.exec(readJson<{ scripts: Record<string, string> }>(`${DIR}/package.json`).scripts['start'] ?? '')?.[1] ?? '';
const compiled = readJson<{ files: string[] }>(`${DIR}/tsconfig.advertised.json`).files;

describe('the multi-agent scripts the docs tell people to run', () => {
  it('are found, so an empty scan cannot pass the checks below', () => {
    expect([...advertised]).toEqual(expect.arrayContaining(['tla-demo.ts', 'team-demo.ts', 'coherence-demo.ts']));
    expect(start).toBe('run.ts');
  });

  it("are exactly what CI compiles, with the example's npm start", () => {
    expect([...compiled].sort()).toEqual([...new Set([...advertised, start])].sort());
  });

  it('are compiled by the bridge typecheck workflow', () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/bridge-typecheck.yml'), 'utf8');
    expect(workflow).toContain(`run: npx tsc --noEmit -p ${DIR}/tsconfig.advertised.json`);
  });
});
