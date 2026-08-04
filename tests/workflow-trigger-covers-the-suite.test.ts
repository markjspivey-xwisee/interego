/**
 * The third list in an identity that only two members ever honoured.
 *
 * `vitest.config.ts` decides WHAT the root suite executes. `tsconfig.check.json` decides what
 * COMPILES, and its own comment already asserts those two must name the same globs. The third
 * list is `.github/workflows/bridge-typecheck.yml`'s `paths:` trigger, which decides whether
 * the job that runs that suite STARTS AT ALL — and nothing ever tied it to the other two.
 *
 * The measured history: `integrations/**` was in vitest's `include` (3 test files, importing
 * integrations-local `src/`) and in `tsconfig.check.json`'s include, and was in NEITHER paths
 * list. bridge-typecheck.yml is the only workflow that runs `npx vitest run`, so a commit
 * whose changed set was confined to `integrations/` merged with those tests never executed.
 * The same omission covered `vitest.config.ts` itself — the file that decides what the suite
 * runs — and the `tools/` modules vitest loads on every run (`vitest-typecheck-setup.mjs` as
 * globalSetup, `vitest-run-integrity.mjs` as a reporter), because only their sibling
 * `tools/typecheck-gate.mjs` happened to have a named workflow step, which is a different
 * question. Those entries have since been added by hand. Nothing checked that they stay, and
 * nothing would notice the NEXT root directory omitting itself the same way.
 *
 * No YAML or glob dependency on purpose: `js-yaml` and `minimatch` both resolve here today but
 * are TRANSITIVE, not declared in package.json, and a gate that stops resolving is a gate that
 * stops gating.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** The `- 'pattern'` entries of each `paths:` block, one array per block. */
function pathsBlocks(yaml: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  let indent = 0;
  for (const line of yaml.split(/\r?\n/)) {
    const head = /^(\s*)paths:\s*$/.exec(line);
    if (head) {
      indent = (head[1] ?? '').length;
      current = [];
      blocks.push(current);
      continue;
    }
    if (current === null) continue;
    const entry = /^(\s*)-\s*'([^']+)'\s*$/.exec(line);
    const lead = entry?.[1];
    const pattern = entry?.[2];
    if (lead !== undefined && pattern !== undefined && lead.length > indent) {
      current.push(pattern);
      continue;
    }
    // Comments and blank lines interleave the entries; neither ends the block.
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    current = null;
  }
  return blocks;
}

/** GitHub filter semantics, only as far as the patterns this workflow actually uses. */
function covers(pattern: string, file: string): boolean {
  if (pattern === file) return true;
  if (pattern.endsWith('/**')) return file.startsWith(pattern.slice(0, -2));
  return false;
}

function suiteIncludeGlobs(cfg: string): string[] {
  const arr = /include:\s*\[([^\]]*)\]/.exec(cfg)?.[1];
  if (arr === undefined) {
    throw new Error('vitest.config.ts: no `include:` array — this guard is reading the wrong file');
  }
  const globs = [...arr.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
  expect(globs.length).toBeGreaterThan(0);
  // If this ever matched `coverage.include` instead, the entries stop being test globs.
  // Fail loudly here rather than assert confidently against the wrong list.
  for (const g of globs) {
    expect(g.endsWith('.test.ts'), `read a non-test glob '${g}' — wrong include array`).toBe(true);
  }
  return globs;
}

/** `'./tools/x.mjs'` entries vitest.config.ts loads: globalSetup and reporters. */
function toolsLoadedByConfig(cfg: string): string[] {
  return [...new Set([...cfg.matchAll(/'\.\/(tools\/[A-Za-z0-9._/-]+)'/g)].map((m) => m[1] ?? ''))];
}

describe('the workflow that runs the root suite triggers on everything the suite reads', () => {
  const workflow = readFileSync(`${ROOT}.github/workflows/bridge-typecheck.yml`, 'utf8');
  const config = readFileSync(`${ROOT}vitest.config.ts`, 'utf8');
  const blocks = pathsBlocks(workflow);

  it('still has a paths list for both push and pull_request', () => {
    // Guards the guard: if the parser stops finding the blocks, every assertion below
    // iterates an empty array and passes vacuously.
    expect(blocks.length).toBe(2);
    for (const block of blocks) expect(block.length).toBeGreaterThan(5);
  });

  it('keeps the two duplicated lists identical — the header says so, nothing checked it', () => {
    const [push, pr] = blocks;
    expect(push).toBeDefined();
    expect(pr).toEqual(push);
  });

  it('names every root directory vitest collects tests from', () => {
    const roots = [...new Set(suiteIncludeGlobs(config).map((g) => `${g.split('/')[0] ?? ''}/**`))];
    for (const block of blocks) {
      for (const root of roots) {
        expect(
          block,
          `bridge-typecheck.yml paths: is missing '${root}'. It is the only runner of the root `
            + 'suite, so a commit touching only that directory merges with those tests never run.',
        ).toContain(root);
      }
    }
  });

  it('names vitest.config.ts itself — it decides what the suite runs', () => {
    for (const block of blocks) {
      expect(
        block.some((p) => covers(p, 'vitest.config.ts')),
        'paths: does not cover vitest.config.ts, so narrowing the suite triggers nothing',
      ).toBe(true);
    }
  });

  it('names every tools/ file vitest.config.ts loads (globalSetup + reporters)', () => {
    const tools = toolsLoadedByConfig(config);
    expect(tools.length, 'no tools/ module read out of vitest.config.ts — the regex is wrong')
      .toBeGreaterThan(0);
    for (const block of blocks) {
      for (const tool of tools) {
        expect(
          block.some((p) => covers(p, tool)),
          `paths: covers no pattern for '${tool}', which the suite loads on every run`,
        ).toBe(true);
      }
    }
  });
});
