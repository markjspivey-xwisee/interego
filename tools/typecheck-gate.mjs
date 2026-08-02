#!/usr/bin/env node
/**
 * The compiler that was missing from `npx vitest run tests/`.
 *
 * ── WHAT WAS NOT BEING TYPECHECKED, AND HOW IT WAS FOUND ─────────────────────
 *
 * vitest transpiles with esbuild. It strips types and runs the JavaScript underneath, so a
 * program that does not compile runs anyway. Everything else in this repo is covered by
 * something — `packages/*` by `npm run build`, `deploy/mcp-relay/*.ts` by relay-tests.yml,
 * every `applications/<v>/src` by that vertical's `bridge/tsconfig.json` include — but
 * `tests/**` was in no tsconfig at all, and `applications/shared-workspace` is the one
 * application with no `bridge/` directory and therefore no tsconfig reaching its source.
 *
 * Measured: deleting a required bail-out from `readAcceptanceRecord` left all 237 tests
 * GREEN, while `tsc` caught it outright. The suite could not see it because there was no
 * compiler in the loop.
 *
 * ── WHY A GATE SCRIPT AND NOT JUST `tsc -p` ──────────────────────────────────
 *
 * Turning the compiler on over a program nobody had ever compiled surfaced 58 pre-existing
 * errors in 18 files, none of them in this round's surface and several of them genuine
 * latent defects (`Object is possibly 'undefined'` in a test's own assertions; three tests
 * importing type names their package does not export). Fixing all of them here would be a
 * different change touching a dozen unrelated verticals, and gating on zero would mean the
 * gate goes in disabled — which is the outcome this file exists to avoid.
 *
 * So it RATCHETS, the same discipline `.github/workflows/a2a-conformance.yml` applies to the
 * A2A TCK:
 *
 *   — ANY error in a file not on {@link LEGACY} fails. New and changed code is fully gated.
 *   — An error count ABOVE a file's pinned number fails. Existing debt cannot grow.
 *   — An error count BELOW its pin fails too, naming the new number. A ratchet that only
 *     tightens when someone remembers to tighten it is a ratchet that never tightens.
 *
 * The pins are a debt register with a total, not a permission slip. Deleting a line from
 * LEGACY is how a file becomes permanently gated.
 *
 * Run: node tools/typecheck-gate.mjs
 * Also runs automatically in `vitest.config.ts`'s globalSetup, so `npx vitest run tests/`
 * cannot report green over source that does not compile, and as its own CI step in
 * bridge-typecheck.yml so it is not reachable only through a setup hook.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = join(ROOT, 'tsconfig.check.json');

/**
 * Files that already failed the day the compiler was first pointed at them, with the exact
 * count each produced. Every one of these predates this gate; none is in
 * `applications/shared-workspace/**` or `tests/workspace-*.test.ts`.
 *
 * Two are not test files at all — they are application and relay source pulled in
 * TRANSITIVELY by a test's imports, and compiled here under `tsconfig.base.json`'s
 * `noUncheckedIndexedAccess` / `strict`, which their own tsconfigs do not set. They cannot be
 * excluded by path (an exclude does not stop a transitive import) and they are not this
 * round's to re-strict, so they are pinned like the rest.
 */
const LEGACY = {
  'applications/foxxi-content-intelligence/src/activity-identity.ts': 2,
  'deploy/mcp-relay/agent-interop-mount.ts': 2,
  'tests/abac.test.ts': 4,
  'tests/agent-framework.test.ts': 19,
  'tests/cas-split.test.ts': 3,
  'tests/constitutional.test.ts': 1,
  'tests/dkg.test.ts': 2,
  'tests/hmd-conformance.test.ts': 1,
  'tests/hypermedia-markdown.test.ts': 1,
  'tests/infrastructure.test.ts': 4,
  'tests/p2p.test.ts': 1,
  'tests/pgsl-cas-persistence.test.ts': 2,
  'tests/pgsl-describe.test.ts': 1,
  'tests/projection-on-publish.test.ts': 1,
  'tests/round25-pgsl-escaping.test.ts': 1,
  'tests/round27-projection-escaping.test.ts': 1,
  'tests/rte-conformance.test.ts': 1,
  'tests/solid.test.ts': 7,
  'tests/transactions.test.ts': 4,
  'tests/xapi-conformance.test.ts': 2,
};

/** `path/to/file.ts(12,3): error TS1234: …` — the only line shape tsc reports errors on. */
const ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error TS\d+:/;

export function runTypecheckGate() {
  const tsc = require.resolve('typescript/lib/tsc.js');
  const run = spawnSync(process.execPath, [tsc, '--noEmit', '-p', PROJECT], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;

  const counts = new Map();
  const samples = new Map();
  for (const line of output.split(/\r?\n/)) {
    const m = ERROR_LINE.exec(line);
    if (!m) continue;
    // tsc prints paths relative to the project when invoked with -p, but normalise anyway so
    // a Windows separator or an absolute path cannot slip a file past its pin.
    const file = relative(ROOT, join(ROOT, m[1])).split('\\').join('/');
    counts.set(file, (counts.get(file) ?? 0) + 1);
    if (!samples.has(file)) samples.set(file, line.trim());
  }

  const failures = [];
  for (const [file, count] of [...counts].sort()) {
    const pinned = LEGACY[file];
    if (pinned === undefined) {
      failures.push(
        `  ${file}: ${count} type error(s), and this file is not on the legacy list.\n`
        + `      ${samples.get(file)}`,
      );
    } else if (count > pinned) {
      failures.push(`  ${file}: ${count} type errors, pinned at ${pinned}. Existing debt may not grow.\n      ${samples.get(file)}`);
    }
  }
  for (const [file, pinned] of Object.entries(LEGACY).sort()) {
    const now = counts.get(file) ?? 0;
    if (now < pinned) {
      failures.push(
        `  ${file}: ${now} type errors, pinned at ${pinned}. It IMPROVED — lower the pin in `
        + 'tools/typecheck-gate.mjs (or delete the line if it is 0) so the gain cannot be lost again.',
      );
    }
  }

  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const pinnedTotal = Object.values(LEGACY).reduce((a, b) => a + b, 0);
  return { ok: failures.length === 0, failures, total, pinnedTotal, output };
}

/** The message a human or a CI log sees. Kept out of the checker so vitest can reuse it. */
export function typecheckGateReport(result) {
  if (result.ok) {
    return `typecheck gate: ${result.total} known error(s) across ${Object.keys(LEGACY).length} `
      + 'legacy file(s), none anywhere else.';
  }
  return [
    '',
    '★ TYPECHECK GATE FAILED — tsconfig.check.json',
    '',
    'vitest does not typecheck. This gate is the compiler for `tests/**` and',
    '`applications/shared-workspace/**`, and it just found something the suite cannot see:',
    '',
    ...result.failures,
    '',
    `(${result.total} total; ${result.pinnedTotal} are pinned pre-existing debt.)`,
    'Reproduce: npx tsc --noEmit -p tsconfig.check.json',
    '',
  ].join('\n');
}

// Direct invocation — `node tools/typecheck-gate.mjs`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = runTypecheckGate();
  console.log(typecheckGateReport(result));
  process.exit(result.ok ? 0 : 1);
}
