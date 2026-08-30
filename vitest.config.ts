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
    //
    // ★ AND IT IS THE ONLY THING HERE THAT READS `packages/*/src`. THE TESTS DO NOT.
    //
    // Every `packages/*/package.json` points its `exports` at `dist/`, so a `tests/` file
    // importing `@interego/core` or `@interego/p2p` executes the BUILT artifact. Editing
    // `packages/core/src/rdf/jsonld.ts` and re-running the suite measures the PREVIOUS
    // build. CI is safe — `bridge-typecheck.yml` runs `npm run build` before
    // `npx vitest run`, and `dist/` is gitignored so that build is always fresh — but a
    // local run is not, and this produced two wrong measurements in one session: a real
    // defect reintroduced into `packages/p2p/src` reported GREEN, and on another run RED
    // for an unrelated timing reason, both against a stale `dist/`.
    //
    // So: after touching anything under `packages/*/src`, run
    // `npm run build --workspace <pkg>` before believing the suite. The gate below reads
    // source directly and still catches TYPE errors, which is precisely why a green
    // typecheck beside a green suite is not evidence the suite ran your change.
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
    /**
     * ★★ A CHOSEN BUDGET, REPLACING AN ACCIDENTAL ONE. There was no `testTimeout` here, so all
     * 331 modules inherited vitest's 5,000 ms default — a number nobody picked for a suite whose
     * tests spawn child processes, read the whole tracked tree, and make real HTTP round trips.
     *
     * ★ IT COST THREE FAILURES IN ONE SESSION, none of them a defect in the code under test:
     *   · tests/line-endings-are-normalised reads ~2,700 files: 2.6 s alone, 5,862 ms under full
     *     suite load. It failed by 862 ms on a perfectly clean tree.
     *   · tests/railway-running-build asserts on `readRunningBuild`, whose OWN deadline is
     *     15,000 ms — THREE TIMES its test budget. vitest killed round trips the tool considered
     *     healthy; 24/24 in isolation, three failures in the suite with an empty request log.
     *   · tests/bounded-manifest has bodies at 15.5 s and 9 s.
     * A test cannot have a shorter deadline than the operation it asserts on, or it stops
     * measuring the operation and starts measuring the machine.
     *
     * ★ 20 s IS NOT 'RELAXING A DEADLINE', which this repo refuses elsewhere and should. Nothing
     * deliberate is being widened: 5,000 ms was vitest's default, not a decision. The 21 files
     * that state their OWN budget still do — an explicit `}, 30_000)` beside a test that spawns a
     * process is a claim about that test, and it overrides this. This only stops a body nobody
     * ever budgeted from failing because another suite was busy.
     *
     * ★ IT STILL FAILS A HANG. A test that never settles takes 20 s to say so instead of 5. That
     * is the whole cost, and it buys not training people to re-run instead of read.
     */
    testTimeout: 20_000,
    reporters: ['default', './tools/vitest-run-integrity.mjs'],
    // ★ THE REASON THESE ARE PINNED IS NOT IN THIS FILE, AND IT USED TO BE UNFINDABLE.
    // This comment said "the same shared Azure CSS pod" for months after Azure was
    // deliberately destroyed, so it read as a description of something gone — while the
    // hazard had simply MIGRATED to Railway with the rest of the stack, keeping its shape:
    // one container, five suites. Anyone re-asking "can we drop singleFork?" reads
    // `poolOptions` and nothing else, and the answer lives in a helper two directories away
    // that no grep over `*.test.ts` reaches. So the answer is written down, in one place:
    //
    //     applications/_shared/tests/shared-live-externals.ts
    //
    // It names every live thing outside this process that more than one collected module
    // shares, with the switch that arms each, the switch that turns it off, and the MEASURED
    // fact of whether CI throws either. `shared-live-externals.test.ts` keeps every field of
    // it true and derives the completeness of the set from a rule rather than from memory —
    // the first version of that registry said "three" and omitted the only one CI arms.
    // (It also asserts this pointer still exists, so deleting these lines is red.)
    poolOptions: {
      threads: {
        // Single-threaded pool: no cross-file parallelism, within-file parallelism untouched.
        singleThread: true,
      },
      forks: {
        // ★★ PARALLELISM WAS TRIED AND REJECTED, on evidence, and this is not a placeholder
        // for someone to flip. The round that tried it reported two findings and both cut
        // against it: CI runners are 2-core, so a local multi-fork profile does not transfer
        // to the machine that actually gates, and it made WALL-CLOCK assertions flake — a test
        // asserting three polls inside a 40 ms window failed under fork contention and passed
        // alone. Making every timing assertion in this repo deterministic is a much larger
        // programme than a local saving justifies. Those two numbers are that round's, not
        // re-driven here; what IS re-driven here is everything below about the pod.
        //
        // While this stays true, every module in a run shares one process, which is why
        // `vi.stubEnv` without a restore leaks across FILES — see the `afterEach` note in
        // shared-live-externals.test.ts, where a leaked SKIP_POD_TESTS would silently empty
        // the five pod suites.
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
