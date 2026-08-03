import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'applications/**/tests/**/*.test.ts', 'integrations/**/tests/**/*.test.ts', 'mcp-server/tests/**/*.test.ts'],
    globals: false,
    // ★ THIS DOES NOT TYPECHECK THE SUITE, AND READING IT AS THOUGH IT DID WAS THE GAP.
    // vitest's `typecheck` block collects TYPE TESTS — files matching `typecheck.include`,
    // which defaults to `**/*.test-d.ts`. There are none in this repo, so the setting has
    // been enabled and inert: every file above was transpiled by esbuild with the types
    // stripped and never compiled. Deleting a required bail-out from application source left
    // all 237 tests green while `tsc` caught it in one pass. The real compiler is the
    // globalSetup below.
    typecheck: {
      enabled: true,
    },
    // ★ THE COMPILER, RUN BEFORE COLLECTION. `tools/typecheck-gate.mjs` compiles
    // `tsconfig.check.json` — the compiler for every file vitest executes — and throws on any
    // error outside a pinned legacy list. That include list was two globs when this sentence
    // was written (`tests/**` plus `applications/shared-workspace/**`) and is now seven; the
    // identical sentence in `tools/typecheck-gate.mjs` was generalised when the list grew and
    // this copy was not, so it is generalised here rather than re-enumerated — read the
    // `include` array for the current set. Wired here rather than into an npm script because
    // the command people type is `npx vitest run tests/`, which never reads package.json.
    // ~6s per invocation.
    globalSetup: ['./tools/vitest-typecheck-setup.mjs'],
    // ★ THE CHECK THAT THE SUITE RAN AT ALL, and it is here rather than in a workflow for the
    // same reason globalSetup is: the command people type is `npx vitest run tests/`, which
    // reads this file and nothing else. `'default'` is listed explicitly because naming any
    // reporter replaces the default one — dropping it would trade the whole summary for the
    // gate, which is the sort of silent coverage loss this pair exists to prevent.
    //
    // What it caught: AXIS A blocked the single worker for 66.8s, vitest's 60s birpc deadline
    // killed it, and `Test Files 2 passed (185)` was the entire report of a run that never
    // executed 183 files. See tools/vitest-run-integrity.mjs.
    reporters: ['default', './tools/vitest-run-integrity.mjs'],
    // Pod-touching tests (Tier 2 + Tier 8 vertical tests) all hit the
    // same shared Azure CSS pod. publish() is now CAS-safe via HTTP
    // If-Match (see src/solid/client.ts), so concurrent writes don't
    // clobber the manifest — but each retry is a network roundtrip,
    // so serializing pod-touching tests is faster than retry-storms
    // and gives more deterministic timing for CI gates.
    poolOptions: {
      threads: {
        // Single-threaded pool eliminates cross-file parallelism without
        // disabling within-file parallelism. ~10s slower in best case;
        // dramatically more reliable for the pod-touching tests.
        singleThread: true,
      },
      forks: {
        singleFork: true,
      },
    },
    coverage: {
      // V8-native; no Babel transform, lower memory than istanbul.
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['packages/*/src/**/*.ts'],
      // Add to exclude only with a comment explaining why.
      exclude: [
        'packages/*/src/**/*.d.ts',
        'packages/*/src/**/types.ts',           // pure type modules (no runtime to measure)
        'packages/connectors/src/index.ts',     // network-dependent; mocked tests cover dispatch only
        'packages/extractors/src/index.ts',     // wraps platform extractors; e2e tests live elsewhere
      ],
      // Coverage thresholds active only when --coverage flag is passed
      // (i.e., `npm run test:coverage`). The default `npm test` runs
      // without coverage and is unaffected. Initial baseline conservative
      // so the gate rejects regressions without forcing a backfill PR
      // before the rest of the codebase catches up. Ratchet upward as
      // gaps close.
      thresholds: {
        lines: 50,
        branches: 50,
        functions: 50,
        statements: 50,
        // Per-glob overrides for modules where coverage is expected to
        // stay high — these have dedicated test files and small surface.
        'packages/compliance/src/**/*.ts': { lines: 80, branches: 70, functions: 80, statements: 80 },
        'packages/security-txt/src/**/*.ts': { lines: 90, branches: 80, functions: 100, statements: 90 },
        'packages/ops/src/**/*.ts': { lines: 80, branches: 70, functions: 90, statements: 80 },
        'packages/privacy/src/**/*.ts': { lines: 80, branches: 70, functions: 80, statements: 80 },
      },
    },
  },
});
