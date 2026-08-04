/**
 * The run-integrity floor, driven through the REAL reporter.
 *
 * ★ WHY THIS FILE EXISTS. `tools/vitest-run-integrity.mjs` had no test of any kind, so the
 * value of `MIN_TEST_MODULES` was not mutation-testable at all — which is precisely why it
 * was allowed to rot to 14 modules below the tree it is a floor for. Three separate
 * mechanisms were measured on the real reporter and all three reported GREEN:
 *
 *   - a floor 14 below the tree (drift nothing could observe);
 *   - `integrations/**` and `mcp-server/tests/**` BOTH ceasing to match, which is the
 *     directory-move scenario check 3 exists for, and which no scalar floor can catch
 *     because a broken glob shrinks `planned` and `treeTotal` together;
 *   - and, in the other direction, a false POSITIVE: `npx vitest run --root mcp-server`
 *     still loads the root config, so the floor fired on a 2-module root and claimed the
 *     tree had shrunk.
 *
 * The reporter is imported unmodified and driven with a fake Vitest. A double standing in
 * for the reporter could not express any of the three.
 */
import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Dynamic import through a URL expression: `tools/vitest-run-integrity.mjs` is untyped JS
// and a static specifier would be TS7016 under tsconfig.check.json, which compiles this
// file in vitest's globalSetup and would fail the whole suite before collection.
const load = async (): Promise<new () => {
  onInit: (v: unknown) => void;
  onTestRunStart: (specs: unknown[]) => void;
  onTestRunEnd: (mods: unknown[], errs: unknown[], reason: string) => Promise<void>;
}> => (await import(
  new URL('../tools/vitest-run-integrity.mjs', import.meta.url).href
) as { default: new () => never }).default;

/**
 * ★ THE FLOOR IS READ OUT OF THE MODULE, NOT RESTATED HERE.
 *
 * Every fixture below used to be a literal chosen to sit on one side of the floor of the
 * day — 200 modules for "honest run", 400 for "drifted", and the exact string "to 390" for
 * the number the failure names. Raising the floor 200 -> 205 turned the CONTROL case red:
 * 200 modules is now below the floor, so the case asserting an honest run does not fail
 * asserted the opposite of what its name says. A self-test that reds whenever the thing it
 * guards is legitimately tightened gets edited to match instead of read, and then it is
 * pinning last month's number. Deriving is the fix — these cases now describe positions
 * RELATIVE to the floor, which is what they always meant.
 */
const loadFloor = async (): Promise<{ floor: number; allowance: number }> => {
  const m = (await import(
    new URL('../tools/vitest-run-integrity.mjs', import.meta.url).href
  )) as { MIN_TEST_MODULES?: number; FLOOR_ALLOWANCE?: number };
  const floor = m.MIN_TEST_MODULES;
  const allowance = m.FLOOR_ALLOWANCE;
  // Not `?? 205`: a default would silently restore the two-sources-of-truth problem the
  // moment the export is renamed, and every case below would go on passing against it.
  expect(typeof floor, 'vitest-run-integrity.mjs stopped exporting MIN_TEST_MODULES')
    .toBe('number');
  expect(typeof allowance, 'vitest-run-integrity.mjs stopped exporting FLOOR_ALLOWANCE')
    .toBe('number');
  return { floor: floor as number, allowance: allowance as number };
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE = [
  'tests/**/*.test.ts', 'applications/**/tests/**/*.test.ts',
  'integrations/**/tests/**/*.test.ts', 'mcp-server/tests/**/*.test.ts',
];

/**
 * ★ `process.exitCode` IS RESTORED AROUND EVERY CASE. vitest pins singleThread/singleFork
 * here, so every file shares one globalThis and one process: a case that exercises the
 * failure path sets the REAL exit code to 1 and would turn a fully green suite red from
 * here — and it would be blamed on whichever file ran last, not on this one. That is the
 * shared-realm pollution class. The `finally` below is load-bearing; do not simplify it.
 */
async function drive(opts: { root: string; specs: string[]; planned: number }): Promise<{
  failed: boolean; out: string;
}> {
  const Reporter = await load();
  const r = new Reporter();
  const specs = opts.specs.map((p) => ({ moduleId: resolve(opts.root, p) }));
  r.onInit({
    config: { root: opts.root },
    projects: [{ config: { include: INCLUDE } }],
    globTestSpecifications: async () => specs,
  });
  r.onTestRunStart(new Array(opts.planned));
  const modules = Array.from({ length: opts.planned }, (_, i) => ({
    moduleId: `m${i}`, state: () => 'passed',
  }));
  const priorExit = process.exitCode;
  const priorError = console.error;
  let out = '';
  console.error = (m?: unknown): void => { out += String(m); };
  try {
    await r.onTestRunEnd(modules, [], 'passed');
  } finally {
    console.error = priorError;
    process.exitCode = priorExit;
  }
  return { failed: out.includes('RUN INTEGRITY GATE FAILED'), out };
}

/** n modules spread across the four real roots, each root non-empty. */
const spread = (n: number): string[] => Array.from({ length: n }, (_, i) => ([
  `tests/t${i}.test.ts`, `applications/a/tests/t${i}.test.ts`,
  `integrations/i/tests/t${i}.test.ts`, `mcp-server/tests/t${i}.test.ts`,
][i % 4] as string));

describe('the run-integrity floor', () => {
  it('★ passes an honest whole-tree run — the control, without which every case below is satisfied by a gate that always fails', async () => {
    const { floor, allowance } = await loadFloor();
    // At the floor exactly: above the "planned < floor" check and inside the drift
    // allowance, so an honest run here must be silent.
    const n = floor + Math.floor(allowance / 2);
    const r = await drive({ root: ROOT, specs: spread(n), planned: n });
    expect(r.failed, r.out).toBe(false);
  });

  it('★ fails when the floor has drifted below the tree, and names the number to write', async () => {
    const { floor, allowance } = await loadFloor();
    // Well past the allowance, so the drift check must fire and name `n - allowance`.
    const n = floor + allowance * 20;
    const r = await drive({ root: ROOT, specs: spread(n), planned: n });
    expect(r.failed).toBe(true);
    expect(r.out).toMatch(
      new RegExp(`Raise MIN_TEST_MODULES in tools/vitest-run-integrity\\.mjs to ${n - allowance}`),
    );
  });

  it('★★ fails when a small `include` root stops matching — the case NO scalar floor can catch', async () => {
    // Above the floor and inside the drift allowance: both other checks are blind here by
    // construction, which is the whole point.
    const { floor, allowance } = await loadFloor();
    const n = floor + Math.floor(allowance / 2);
    const specs = Array.from({ length: n }, (_, i) => (i % 2
      ? `tests/t${i}.test.ts` : `applications/a/tests/t${i}.test.ts`));
    const r = await drive({ root: ROOT, specs, planned: n });
    expect(r.failed).toBe(true);
    expect(r.out).toMatch(/`integrations\/\*\*\/tests\/\*\*\/\*\.test\.ts`[\s\S]*matches no test module/);
    expect(r.out).toMatch(/`mcp-server\/tests\/\*\*\/\*\.test\.ts`[\s\S]*matches no test module/);
    // The controls: neither of the other two checks fired, so this failure is the per-glob one.
    expect(r.out).not.toMatch(/and the floor is/);
    expect(r.out).not.toMatch(/Raise MIN_TEST_MODULES/);
  });

  it('★ stays silent under `--root mcp-server`, where three globs match nothing legitimately', async () => {
    // Before the scope predicate this failed, claiming the tree "shrank" to 2 — and it
    // escaped CI only because the workflow line happens to name a file.
    const root = resolve(ROOT, 'mcp-server');
    const r = await drive({ root, specs: ['tests/a.test.ts', 'tests/b.test.ts'], planned: 2 });
    expect(r.failed, r.out).toBe(false);
  });
});
