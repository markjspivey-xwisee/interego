/**
 * THE MULTI-AGENT SCRIPTS WE TELL PEOPLE TO RUN ARE THE ONES CI COMPILES.
 *
 * The README advertises `npx tsx examples/multi-agent/<demo>.ts`, and tsx never typechecks.
 * Nothing compiled those scripts, so tla-demo.ts and team-demo.ts went on passing `sources` in a
 * provenance facet after the builder had stopped reading it; the field is `wasDerivedFrom`. What
 * they published silently lacked what it was derived from, and only a compiler would have said so
 * (2026-09-28). `.github/workflows/bridge-typecheck.yml` now compiles
 * examples/multi-agent/tsconfig.advertised.json. tools/advertised-demos-lint.mjs keeps that list
 * equal to the scripts the docs tell people to run, plus the example's own `npm start`. lint.yml
 * runs it on every pull request, because the scan reads every Markdown file and the suite's own
 * workflow is path-filtered (Codex, on #567).
 *
 * It lives here, not in `tests/`, because it reads `examples/`, which the base runs without.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADVERTISED_TSCONFIG, DEMO_DIR, ROOT, advertisedDemos, judge, startScript } from '../../tools/advertised-demos-lint.mjs';

describe('the multi-agent scripts the docs tell people to run', () => {
  it('are found, so an empty scan cannot pass the checks below', () => {
    expect([...advertisedDemos()]).toEqual(expect.arrayContaining(['tla-demo.ts', 'team-demo.ts', 'coherence-demo.ts']));
    expect(startScript()).toBe('run.ts');
  });

  it("are exactly what CI compiles, with the example's npm start", () => {
    expect(judge()).toEqual([]);
  });

  it('are compiled by the bridge typecheck workflow', () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/bridge-typecheck.yml'), 'utf8');
    expect(workflow).toContain(`run: npx tsc --noEmit -p ${ADVERTISED_TSCONFIG}`);
  });

  it('are checked on every pull request, not only when the suite runs (Codex, on #567)', () => {
    const lint = readFileSync(join(ROOT, '.github/workflows/lint.yml'), 'utf8');
    expect(lint).toContain('run: node tools/advertised-demos-lint.mjs');
    // No `paths:` key before the jobs; its header comments may mention the word.
    const triggers = lint.slice(0, lint.indexOf('\njobs:')).split('\n').filter(line => !/^\s*#/.test(line));
    expect(triggers.some(line => /^\s*on:/.test(line))).toBe(true);
    expect(triggers.filter(line => /^\s*paths:/.test(line))).toEqual([]);
  });

  it('flags a demo a document advertises that CI does not compile', () => {
    const repo = mkdtempSync(join(tmpdir(), 'advertised-demos-'));
    try {
      mkdirSync(join(repo, DEMO_DIR), { recursive: true });
      mkdirSync(join(repo, 'quickstart'), { recursive: true });
      writeFileSync(join(repo, 'quickstart', 'README.md'), 'Try `npx tsx examples/multi-agent/new-demo.ts`.\n');
      writeFileSync(join(repo, DEMO_DIR, 'package.json'), JSON.stringify({ scripts: { start: 'tsx run.ts' } }));
      writeFileSync(join(repo, ADVERTISED_TSCONFIG), JSON.stringify({ files: ['run.ts'] }));
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['add', '-A'], { cwd: repo });
      expect(judge(repo)).toEqual([expect.stringContaining('new-demo.ts is advertised')]);
      writeFileSync(join(repo, ADVERTISED_TSCONFIG), JSON.stringify({ files: ['new-demo.ts', 'run.ts'] }));
      expect(judge(repo)).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
