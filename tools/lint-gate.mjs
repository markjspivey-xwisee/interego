/**
 * The linter that had never run, plus the check that it is still running.
 *
 * ── WHAT WAS BROKEN ──────────────────────────────────────────────────────────
 *
 * `npm run lint` has been `eslint packages/*​/src/ tests/` since the initial commit, and
 * the repo has never contained an eslint config in ANY format — no `.eslintrc*`, no
 * `eslint.config.*`, nothing in git history. `eslint@^9` treats a missing flat config as
 * a hard error, so for an unknown span of time the script's entire output was:
 *
 *   ESLint couldn't find an eslint.config.(js|mjs|cjs) file.
 *
 * exit code 2, zero files examined. No workflow in `.github/workflows/` ever called
 * `npm run lint`, so nothing reported the failure. The rules were reconstructed from the
 * `eslint-disable` directives left in the source — see the header of `eslint.config.js`.
 *
 * ── WHY A GATE AND NOT JUST THE eslint EXIT CODE ─────────────────────────────
 *
 * Two separate failure modes, and the raw exit code catches neither.
 *
 * 1. THE COUNT. Pointing the recovered config at 304 previously-unlinted files reports 222
 *    errors. Failing on all of them puts the script straight back to "always red, therefore
 *    ignored" — the state it was already in. Failing on none of them means the next one is
 *    invisible. So it RATCHETS per file, exactly as `tools/typecheck-gate.mjs` does: a file
 *    not on {@link BASELINE} may have no errors at all, a pinned file may not exceed its
 *    number, and a pinned file that IMPROVES also fails, naming the new number. A pin that
 *    only tightens when someone remembers is a pin that never tightens.
 *
 * 2. ★ THE FILE COUNT — the failure mode that produced this whole task. `eslint` exits 0
 *    when it lints nothing. A config whose `ignores` swallow the tree, a `files` glob that
 *    stops matching after a directory move, a shell that fails to expand `packages/*​/src/`:
 *    every one of those is a silent, green, total loss of coverage, indistinguishable from
 *    success. {@link MIN_FILES} is the floor. If the linter examines fewer files than it did
 *    the day this was written, that is not a clean run, and this fails and says so.
 *
 * A lint script whose only consumer is a human typing it is the same shape of dead signal
 * as a lint script with no config, so `.github/workflows/lint.yml` runs this on every push
 * and `npm run lint` is this file rather than a bare `eslint` invocation.
 *
 * Run: node tools/lint-gate.mjs
 * Reproduce the raw output: npx eslint packages/*​/src/ tests/
 *
 * ── NO SHEBANG ───────────────────────────────────────────────────────────────
 * Only because nothing needs one: this file is run as `node tools/lint-gate.mjs` and never
 * as an executable. It is NOT because a hashbang would break an importer. That reason was
 * asserted here and at the top of `tools/typecheck-gate.mjs`, and it was measured and found
 * false — vite's `ssrTransformScript` hoists around a leading `#!` and vite-node blanks it.
 * See that file's header for the measurement, so this does not get re-derived from scratch.
 */
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The lint surface, matching the `lint` script's historical targets. These are passed to
 * eslint as directories rather than shell globs so the gate does not depend on the calling
 * shell expanding `packages/*​/src/` — cmd.exe does not, and a Windows run would otherwise
 * lint nothing and pass.
 */
const TARGETS = ['packages', 'tests'];

/**
 * Files that had errors the day the config was recovered, with the exact count each
 * produced. Nothing here is new code; every entry predates the config existing at all.
 *
 * 169 of the 222 are `@typescript-eslint/no-explicit-any` and 49 are unused imports and
 * bindings in tests — hygiene, not defects, and pinned rather than mass-edited across 47
 * files in a change that is about making the signal work. The genuine finds were fixed
 * instead of pinned: a no-op expression statement standing in for a mock repair in
 * `tests/connectors.test.ts`, a load-bearing `console.warn` in `packages/core/src/crypto/
 * ipfs.ts` that now says why it is exempt, five redundant character-class escapes, five stale
 * `eslint-disable` directives, and a `let s` that is never reassigned in `mdvault/src/paths.ts`.
 *
 * Three of those five directives name a rule this config does not enable (`no-unnecessary-
 * condition` twice in `core/src/http/fetch.ts`, `no-undef` in `solid/src/did.ts`); the other
 * two — `no-unused-vars` in `pgsl/src/runtime-eval.ts`, `no-constant-condition` in
 * `mdvault/src/paths.ts` — name rules that ARE enabled and simply had nothing to suppress.
 * The sentence here said all five were the first kind. Both kinds are dead directives and
 * both were removed; the count was right and the characterisation was not.
 *
 * `tests/workspace-*.test.ts` entries are pinned and NOT fixed because another change owns
 * those files; the four `no-regex-spaces` in `workspace-membership.test.ts` are real and
 * left for that owner.
 */
const BASELINE = {
  'packages/connectors/src/index.ts': 7,
  'packages/core/src/affordance/compute.ts': 13,
  'packages/core/src/affordance/engine.ts': 11,
  'packages/core/src/crypto/wallet.ts': 1,
  'packages/core/src/crypto/zk/proofs.ts': 1,
  'packages/core/src/model/registry.ts': 23,
  'packages/core/src/rdf/turtle-parser.ts': 3,
  'packages/extractors/src/index.ts': 1,
  'packages/pgsl-store/src/fdb-real.ts': 6,
  'packages/pgsl-store/src/pg-store.ts': 1,
  'packages/pgsl/src/affordance-decorators.ts': 7,
  'packages/pgsl/src/agent-framework.ts': 7,
  'packages/pgsl/src/coherence.ts': 1,
  'packages/pgsl/src/decision-functor.ts': 1,
  'packages/pgsl/src/fact-extraction.ts': 1,
  'packages/pgsl/src/infrastructure.ts': 8,
  'packages/pgsl/src/lattice.ts': 1,
  'packages/pgsl/src/question-router.ts': 1,
  'packages/pgsl/src/runtime-eval.ts': 1,
  'packages/pgsl/src/tools.ts': 3,
  'packages/pgsl/src/virtualized-layer.ts': 3,
  'packages/solid/src/sdk.ts': 2,
  'tests/adversarial-audit.test.ts': 2,
  'tests/affordance.test.ts': 1,
  'tests/agent-framework.test.ts': 5,
  'tests/causality.test.ts': 3,
  'tests/context-graphs.test.ts': 1,
  'tests/derivation.test.ts': 12,
  'tests/engagement-durability.test.ts': 9,
  'tests/federation.test.ts': 1,
  'tests/infrastructure.test.ts': 8,
  'tests/interrogative-router.test.ts': 16,
  'tests/multi-agent-integration.test.ts': 22,
  'tests/p2p-mirror.test.ts': 2,
  'tests/pgsl-cas-persistence.test.ts': 2,
  'tests/pgsl-coherence.test.ts': 1,
  'tests/pgsl-shacl.test.ts': 1,
  'tests/pgsl-sparql.test.ts': 4,
  'tests/pgsl.test.ts': 8,
  'tests/projection-facets.test.ts': 4,
  'tests/render-view-affordance.test.ts': 1,
  'tests/rte-conformance.test.ts': 5,
  'tests/sharing.test.ts': 1,
  'tests/solid.test.ts': 2,
  'tests/workspace-can.test.ts': 1,
  'tests/workspace-membership.test.ts': 5,
  'tests/xapi-conformance.test.ts': 2,
};

/**
 * The floor on how many files eslint must actually examine. 304 were linted the day this
 * was written; the allowance below it absorbs ordinary file deletion without letting a
 * coverage collapse through. Raise it when the tree grows — a floor that drifts far below
 * reality stops being a floor.
 */
const MIN_FILES = 280;

export async function runLintGate() {
  // The programmatic API rather than the CLI: `eslint`'s package `exports` does not expose
  // `bin/eslint.js`, and more importantly a config-resolution failure here THROWS instead of
  // becoming an exit code that a caller could mistake for a clean run.
  let report;
  try {
    const eslint = new ESLint({ cwd: ROOT, errorOnUnmatchedPattern: false });
    report = await eslint.lintFiles(TARGETS);
  } catch (err) {
    return {
      ok: false,
      fatal: `eslint could not run: ${err instanceof Error ? err.message : String(err)}`,
      files: 0, total: 0, failures: [],
    };
  }

  const counts = new Map();
  const samples = new Map();
  for (const f of report) {
    const file = relative(ROOT, f.filePath).split('\\').join('/');
    const errors = f.messages.filter(m => m.severity === 2);
    if (!errors.length) continue;
    counts.set(file, errors.length);
    const m = errors[0];
    samples.set(file, `${file}:${m.line}:${m.column}  ${m.message}  (${m.ruleId ?? 'core'})`);
  }

  const failures = [];

  // ★ Checked FIRST and separately from the error counts. Every count assertion below is
  // trivially satisfied by linting nothing, so "did it lint anything" cannot be inferred
  // from them — it has to be its own question.
  if (report.length < MIN_FILES) {
    failures.push(
      `  eslint examined only ${report.length} file(s); the floor is ${MIN_FILES}.\n`
      + '      Coverage collapsed — check eslint.config.js `ignores`, the TARGETS list in\n'
      + '      this file, and that the config still matches .ts. An eslint run that lints\n'
      + '      nothing exits 0, which is why this is asserted rather than assumed.',
    );
  }

  for (const [file, count] of [...counts].sort()) {
    const pinned = BASELINE[file];
    if (pinned === undefined) {
      failures.push(`  ${file}: ${count} lint error(s), and this file is not on the baseline.\n      ${samples.get(file)}`);
    } else if (count > pinned) {
      failures.push(`  ${file}: ${count} lint errors, pinned at ${pinned}. Existing debt may not grow.\n      ${samples.get(file)}`);
    }
  }
  for (const [file, pinned] of Object.entries(BASELINE).sort()) {
    const now = counts.get(file) ?? 0;
    if (now < pinned) {
      failures.push(
        `  ${file}: ${now} lint errors, pinned at ${pinned}. It IMPROVED — lower the pin in `
        + 'tools/lint-gate.mjs (or delete the line if it is 0) so the gain cannot be lost again.',
      );
    }
  }

  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return { ok: failures.length === 0, failures, files: report.length, total, fatal: null };
}

/** The message a human or a CI log sees. Kept out of the checker so callers can reuse it. */
export function lintGateReport(result) {
  if (result.ok) {
    return `lint gate: ${result.files} file(s) linted, ${result.total} known error(s) across `
      + `${Object.keys(BASELINE).length} baselined file(s), none anywhere else.`;
  }
  if (result.fatal) {
    return ['', '★ LINT GATE FAILED — eslint could not run', '', result.fatal, ''].join('\n');
  }
  return [
    '',
    '★ LINT GATE FAILED — eslint.config.js',
    '',
    ...result.failures,
    '',
    `(${result.files} file(s) linted; ${result.total} error(s) total.)`,
    'Reproduce: npx eslint packages tests',
    'Autofixable subset: npx eslint --fix packages tests',
    '',
  ].join('\n');
}

// Direct invocation — `node tools/lint-gate.mjs`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await runLintGate();
  console.log(lintGateReport(result));
  process.exit(result.ok ? 0 : 1);
}
