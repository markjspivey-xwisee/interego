// ★ THE LINTER THAT HAD NEVER RUN.
//
// `npm run lint` has been `eslint packages/*/src/ tests/` since the initial commit
// (8831fcc), and the repo has never contained an `.eslintrc*` OR an `eslint.config.*`.
// Under ESLint 8 a missing config is a soft default; under the `eslint@^9` this repo
// declares it is a hard error — "ESLint couldn't find an eslint.config.(js|mjs|cjs)" —
// so the script exits 2 having linted nothing. No CI workflow calls `npm run lint`, so
// the failure was never seen. The same defect class as the missing typecheck: a signal
// wired to nothing.
//
// ── HOW THE INTENDED RULE SET WAS RECOVERED ──────────────────────────────────
//
// There is no config in git history to restore, so the rules were reconstructed from
// the `eslint-disable` directives already written into the source. A directive is a
// standing declaration that its rule was expected to be ON and to fire here. Found:
//
//   no-console                                     ~40 sites (relay tests, xapi-lrs, oauth-provider)
//   @typescript-eslint/no-explicit-any             ~20 sites
//   @typescript-eslint/no-require-imports          mcp-server/server.ts
//   @typescript-eslint/no-var-requires             applications/_shared/vc-jwt (renamed rule)
//   @typescript-eslint/no-unused-vars              packages/pgsl/src/runtime-eval.ts
//   @typescript-eslint/no-unnecessary-condition    packages/core/src/http/fetch.ts
//   @typescript-eslint/no-implied-eval             deploy/mcp-relay/_hmd-app-test.ts
//   no-undef, no-constant-condition                packages/solid/src/did.ts, packages/mdvault/src/paths.ts
//
// So: eslint:recommended + typescript-eslint recommended, plus `no-console`. The last two
// are TYPE-AWARE rules, which need a full program per file; see the deliberate omission
// at the bottom of this file.
//
// ── WHY THIS IS NOT `strict-type-checked` ────────────────────────────────────
//
// Turning on everything typescript-eslint offers over 300 previously-unlinted files
// produces a number nobody triages, and an error list nobody reads is the same dead
// signal as no linter at all. The rules here are the ones the codebase's own directives
// asked for. Whatever they report today is pinned per-file in `tools/lint-gate.mjs` and
// ratcheted in BOTH directions, so the debt cannot grow and cannot be quietly re-hidden.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Global ignores. Must be its own object with no other keys — an `ignores` sitting
    // beside `rules` or `files` is scoped to that block only and silently ignores nothing.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/build/**',
      '**/*.d.ts',
      'scratchpad/**',
      // Nested npm projects with their own toolchains and lockfiles; linting them from the
      // root would apply this repo's rules to vendored and generated front-end code.
      'examples/**',
      'integrations/**',
      'interego-main/**',
      'packages/*/coverage/**',
      'coverage/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        // Runtime-provided in Node >= 20 and used unqualified throughout the substrate
        // (fetch/Response/WebSocket in packages/solid, crypto in the signing paths).
        // `globals.node` alone does not carry these, and without them `no-undef` reports
        // every call site — the exact flood this config exists not to produce.
        ...globals.browser,
      },
    },
    rules: {
      // `no-undef` duplicates what tsc already proves, and on `.ts` it is actively wrong:
      // it cannot see type-only names or ambient declarations and reports them as globals.
      // typescript-eslint's own docs say to disable it on typed files. tsc is the authority.
      'no-undef': 'off',

      // Matching C0 control characters is the POINT of the RDF/Turtle escaping validators
      // (packages/core/src/rdf/escape.ts, packages/pgsl/src/projection.ts, and the mdvault
      // path guards). Those regexes exist because a raw \x00 in a literal is the Turtle
      // injection this repo already shipped a fix for. Flagging them inverts the rule.
      'no-control-regex': 'off',

      // Duplicates tsc's `noUnusedLocals`/`noUnusedParameters` for packages/*, but tests/
      // are compiled with both OFF (see tsconfig.check.json) so this is the only thing
      // watching them. `_`-prefixed is the repo's existing convention for "declared to
      // satisfy a signature".
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],

      // `@ts-ignore` silences the NEXT line forever, including after the error it was
      // written for is fixed and a different one appears. `@ts-expect-error` fails once
      // the suppression stops being needed, which is the only form that self-retires.
      '@typescript-eslint/ban-ts-comment': ['error', {
        'ts-expect-error': 'allow-with-description',
        'ts-ignore': true,
        'ts-nocheck': true,
        'ts-check': false,
      }],

      // Asked for by ~40 existing disable directives. Diagnostics belong behind the repo's
      // logging paths; a bare console.log in a served handler leaks into production stdout.
      'no-console': 'error',
    },
  },

  {
    // Tests, tools and codegen scripts are allowed to print: that is their output channel.
    // `packages/*/scripts/**` is in here because `gen-interrogative-table.ts` writes its
    // generated table to stdout — the whole program is a print. Scoped rather than global
    // so a stray console.log in `packages/*/src` still fails.
    files: [
      'tests/**/*.ts', '**/tests/**/*.ts',
      'tools/**/*.{ts,mjs,js}', 'packages/*/scripts/**/*.ts',
      'benchmarks/**', 'demos/**', 'scripts/**',
    ],
    rules: { 'no-console': 'off' },
  },

  {
    // ★ THE RULE'S OWN SUGGESTED FIX BREAKS THE BUILD HERE — MEASURED, NOT ASSUMED.
    //
    // `fdb-real.ts` and `pg-store.ts` `await import()` an OPTIONAL native dependency that
    // is installed only by the workflow that exercises it (`npm install --no-save
    // foundationdb@2` in pgsl-store-fdb.yml, `pg@8` in pgsl-store-pg.yml). Whether the
    // import errors therefore depends on the environment.
    //
    // Swapping `@ts-ignore` for `@ts-expect-error` as ban-ts-comment advises was tried and
    // `tsc -p packages/pgsl-store` answered immediately:
    //
    //   packages/pgsl-store/src/pg-store.ts(53,3): error TS2578: Unused '@ts-expect-error'
    //
    // — because `pg` IS resolvable in this tree. The self-retiring directive retires into a
    // hard compile error in exactly the CI job that installs the dependency and runs the
    // code. `@ts-ignore` is the correct directive for a conditionally-present module; both
    // sites already carry the description explaining why.
    files: ['packages/pgsl-store/src/**/*.ts'],
    rules: {
      '@typescript-eslint/ban-ts-comment': ['error', {
        'ts-expect-error': 'allow-with-description',
        'ts-ignore': 'allow-with-description',
        'ts-nocheck': true,
        'ts-check': false,
      }],
    },
  },

  {
    // `.mjs` tooling under tools/ is plain Node ESM, not TypeScript. The TS-only rules do
    // not apply and `no-undef` must come back on — there is no compiler behind these files,
    // so eslint is the ONLY thing that will catch a typo'd identifier in the gate scripts.
    files: ['**/*.mjs', '**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    rules: { 'no-undef': 'error' },
  },
);

// ── DELIBERATELY NOT ENABLED: the type-aware preset ──────────────────────────
//
// `@typescript-eslint/no-unnecessary-condition` and `no-implied-eval` are named by two
// existing disable directives, and both require `parserOptions.projectService` — a full
// type-check per file, on top of the tsc run the typecheck gate already does. Enabling
// them means every `npm run lint` pays for a second compile of a 300-file program, and
// `no-unnecessary-condition` in particular fires on every defensive `?? []` and `typeof
// x !== 'string'` guard in this codebase, which are written on purpose against untrusted
// wire input. Both stale directives have been removed from the source instead, so the
// "unused eslint-disable" report stays clean and there is no comment claiming a rule is
// suppressed when it is not running. Revisit as a separate change with its own baseline.
