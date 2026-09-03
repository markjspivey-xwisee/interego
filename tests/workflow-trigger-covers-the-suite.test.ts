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
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

  /**
   * ★ THE FILES THE TESTS READ, NOT THE DIRECTORIES VITEST COLLECTS FROM.
   *
   * The three assertions above check where the suite is COLLECTED from. They say nothing
   * about what it READS, and that is a different set: `tests/build-sha-is-verifiable.test.ts`
   * reads `.github/workflows/deploy-railway.yml`, `tests/lint-gate-ci-claim.test.ts` reads
   * `lint.yml`, `tests/engagement-report-mirror.test.ts` reads two root documents. Under
   * the previous lists 17 such files were covered by nothing, so a commit confined to one
   * of them ran ESLint alone — including the deploy false-green this workflow's own
   * `deploy/**` entry was widened to prevent.
   *
   * Derived the same way as `toolsLoadedByConfig`: literal strings in `tests/**` that
   * name an existing repo file. Existence is the filter that keeps it honest — a test
   * mentioning `'foo/bar'` that is not a file is prose, and a test naming a real file is
   * a test that can go stale when that file changes.
   */
  function repoFilesNamedByTests(): string[] {
    const named = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) { walk(p); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        for (const m of readFileSync(p, 'utf8').matchAll(/'([A-Za-z0-9_.\-/@]+)'/g)) {
          const s = m[1] ?? '';
          // Only things shaped like a repo-relative path, and only if one exists.
          if (s.startsWith('/') || s.startsWith('@')) continue;
          if (!s.includes('/') && !/\.[a-z]+$/.test(s)) continue;
          const abs = join(ROOT, s);
          if (!existsSync(abs) || statSync(abs).isDirectory()) continue;
          named.add(s.split('\\').join('/'));
        }
      }
    };
    walk(join(ROOT, 'tests'));
    return [...named].sort();
  }

  it('names every repo file the suite reads, not just the directories it collects from', () => {
    const files = repoFilesNamedByTests();
    // Guards the guard: a regex that stopped matching would pass this vacuously.
    expect(files.length, 'no repo file literals found in tests/** — the scan is broken')
      .toBeGreaterThan(20);
    for (const block of blocks) {
      const uncovered = files.filter((f) => !block.some((p) => covers(p, f)));
      expect(
        uncovered,
        'bridge-typecheck.yml paths: covers none of these, yet the root suite reads them. '
          + 'A commit touching only one of them merges with the assertion about it never run:\n  '
          + uncovered.join('\n  '),
      ).toEqual([]);
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

/**
 * ★ A GATE WHOSE SUBJECT IS THE WHOLE TREE CANNOT SIT BEHIND A PATH FILTER.
 *
 * `tools/docs-claim-lint.mjs` checks that every relative link and every named workflow in
 * the top-level documents RESOLVES ON DISK. Its subject is therefore the TARGET, not the
 * document that links to it — and it ran only in `ontology-lint.yml`, whose `paths:`
 * covered 18 of the 82 targets. Deleting `docs/ARCHITECTURAL-FOUNDATIONS.md` breaks two
 * links and matches none of that list, so the commit that breaks the gate is exactly the
 * commit that skips it. Measured: the linter reports both breaks when run; no workflow
 * would have run it.
 *
 * The same argument already put `spec/conformance/runner.mjs` in `lint.yml` (the only
 * push/PR workflow with no `paths:`), and `lint.yml`'s own header states it for the lint
 * gate. Nothing asserted it, so the third such tool went to the wrong workflow anyway.
 */
describe('whole-tree gates run in a workflow with no paths filter', () => {
  const WORKFLOW_DIR = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

  /** Every `run:` line reachable on push/pull_request WITHOUT a `paths:` restriction. */
  function alwaysRunCommands(): string {
    let all = '';
    for (const f of readdirSync(WORKFLOW_DIR)) {
      if (!/\.ya?ml$/.test(f)) continue;
      const yaml = readFileSync(join(WORKFLOW_DIR, f), 'utf8');
      const on = yaml.slice(yaml.indexOf('\non:'), yaml.indexOf('\npermissions:') + 1);
      if (!/^\s{2}(push|pull_request):/m.test(on)) continue;
      if (/^\s+paths(-ignore)?:/m.test(on)) continue;   // filtered — cannot be relied on
      all += `\n${yaml}`;
    }
    return all;
  }

  const commands = alwaysRunCommands();

  it('finds an unfiltered push/PR workflow at all', () => {
    // Guards the guard: if the parse stops finding one, every assertion below passes
    // vacuously — which is the shape of the defect it exists to catch.
    expect(commands.length, 'no unfiltered push/PR workflow found — the parse is wrong')
      .toBeGreaterThan(200);
  });

  // ★★ THIS LIST IS THE THING IT GUARDS AGAINST. It named three whole-tree gates and two
  // more had since become whole-tree without being added: `docs-drift-lint.mjs` was widened
  // from two files to every tracked markdown, and the byte gate reads `git ls-files` - every
  // tracked text file - while running only inside `npx vitest run`, which is invoked from a
  // workflow WITH a `paths:` list. A hand-written list of the gates that must not be filtered
  // is exactly the shape of drift this file exists to catch, one level up.
  for (const tool of ['tools/docs-claim-lint.mjs', 'tools/lint-gate.mjs',
    'spec/conformance/runner.mjs', 'tools/docs-drift-lint.mjs',
    'tests/line-endings-are-normalised.test.ts']) {
    it(`runs ${tool} on every push and pull request`, () => {
      expect(
        commands.includes(tool),
        `${tool} is invoked by no unfiltered workflow. Its subject spans the tree, so a `
          + 'path filter lets exactly the commits that break it skip the check.',
      ).toBe(true);
    });
  }
});


/**
 * ★★ THE SAME WIRING BUG, ONE WORKFLOW OVER — and the reason it is asserted here rather than
 * trusted.
 *
 * `tools/ontology-lint.mjs` declares SCAN_PATHS: the directories whose TypeScript it reads. It is
 * invoked by exactly one workflow, `.github/workflows/ontology-lint.yml`, which has its own
 * `paths:` filter. Those two lists have to agree, and nothing checked that they did.
 *
 * Measured: `integrations` was added to SCAN_PATHS precisely because two undeclared control IRIs
 * (`nist-rmf:MG-3.1`, `eu-ai-act:Article10`) shipped from integrations/compliance-overlay and no
 * run ever looked there — and the workflow filter still omitted `integrations/**`, so a commit
 * confined to that directory would not have started the job at all. The scan reaching a directory
 * and the job STARTING on a change to it are two independent facts, and only one of them was
 * fixed. This ties them together.
 */
describe('the ontology lint triggers on every directory it scans', () => {
  const workflow = readFileSync(`${ROOT}.github/workflows/ontology-lint.yml`, 'utf8');
  const tool = readFileSync(`${ROOT}tools/ontology-lint.mjs`, 'utf8');
  const blocks = pathsBlocks(workflow);

  /** The SCAN_PATHS array entries, read from the tool rather than restated here. */
  const scanPaths = (): string[] => {
    const arr = /const SCAN_PATHS\s*=\s*\[([\s\S]*?)\n\];/.exec(tool)?.[1];
    if (arr === undefined) {
      throw new Error('tools/ontology-lint.mjs: no `const SCAN_PATHS = [...]` — this guard reads the wrong thing');
    }
    /**
     * Match ELEMENT LINES, rather than stripping comments and harvesting every literal.
     *
     * Stripping was tried and was wrong in a way worth recording: the array's own `//` comments
     * mention paths like `docs/ns/*.ttl`, and the `/` immediately before the `*` opens what a
     * block-comment regex reads as `/*`. Removing block comments first therefore deleted
     * everything from inside that line comment through the close of the next real block comment
     * — five of the six entries — and the guard below saw a one-element list. A bare element line
     * cannot be confused with prose, so nothing needs stripping.
     */
    return [...new Set(
      arr.split('\n')
        .map(line => /^\s*'([^']+)',?\s*$/.exec(line)?.[1])
        .filter((v): v is string => v !== undefined),
    )];
  };

  it('parses both the filter and the scan list — a vacuous pass here would hide the whole check', () => {
    expect(blocks.length).toBe(2);
    expect(scanPaths().length).toBeGreaterThan(3);
  });

  it('names every SCAN_PATHS directory in both the push and pull_request filters', () => {
    for (const block of blocks) {
      for (const dir of scanPaths()) {
        expect(
          block.some(pattern => covers(pattern, `${dir}/anything.ts`)),
          `tools/ontology-lint.mjs scans '${dir}/' but .github/workflows/ontology-lint.yml has no `
            + `paths entry covering it, so a commit confined to that directory never starts the `
            + `lint. Add '${dir}/**'.`,
        ).toBe(true);
      }
    }
  });

  it('names the tool and its allowlist, so a change to the gate itself runs the gate', () => {
    for (const block of blocks) {
      for (const f of ['tools/ontology-lint.mjs', 'tools/ontology-lint.allowlist.txt']) {
        expect(
          block.some(pattern => pattern === f || covers(pattern, f)),
          `${f} is not covered by the ontology-lint paths filter`,
        ).toBe(true);
      }
    }
  });
});
