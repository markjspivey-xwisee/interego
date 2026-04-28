import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'applications/**/tests/**/*.test.ts'],
    globals: false,
    typecheck: {
      enabled: true,
    },
    coverage: {
      // V8-native; no Babel transform, lower memory than istanbul.
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      // Add to exclude only with a comment explaining why.
      exclude: [
        'src/**/*.d.ts',
        'src/**/types.ts',           // pure type modules (no runtime to measure)
        'src/connectors/index.ts',   // network-dependent; mocked tests cover dispatch only
        'src/extractors/index.ts',   // wraps platform extractors; e2e tests live elsewhere
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
        'src/compliance/**/*.ts': { lines: 80, branches: 70, functions: 80, statements: 80 },
        'src/security-txt/**/*.ts': { lines: 90, branches: 80, functions: 100, statements: 90 },
        'src/ops/**/*.ts': { lines: 80, branches: 70, functions: 90, statements: 80 },
        'src/privacy/**/*.ts': { lines: 80, branches: 70, functions: 80, statements: 80 },
      },
    },
  },
});
