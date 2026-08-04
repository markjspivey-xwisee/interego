import { defineConfig } from '@playwright/test';

// Playwright config for the relay's OAuth authorize-page flows.
// Runs against either a locally-spawned dev stack (identity + relay) or
// the deployed Azure endpoints, controlled by the BASE_URL env variable.
//
// Default is the Azure deployment — it's already running and matches what
// real clients hit. Local dev: RUN_LOCAL=1 sets BASE_URL to http://localhost:8092
// and expects the dev stack to already be up on :8091 (identity) + :8092 (relay).

export default defineConfig({
  testDir: './tests',
  // testMatch is NOT optional here, and narrowing it to .spec.ts is the whole
  // point. Playwright's default testMatch is `**/*.@(spec|test).?(c|m)[jt]s?(x)`,
  // which also matches the 29 `*.test.ts` files in this same directory. Those are
  // not Playwright modules — they are standalone tsx PROGRAMS that run their whole
  // body at import and end in `process.exit(...)`. Playwright imports every match
  // during collection, so the first such import killed Playwright's own loader from
  // the inside: zero tests registered, no report written, and the shell saw the unit
  // script's exit 0. `npx playwright test` was returning success without ever
  // loading passkey-oauth.spec.ts. Keep this narrow; tests/e2e-collection.test.ts
  // fails if it widens again.
  testMatch: '**/*.spec.ts',
  timeout: 150_000,
  expect: { timeout: 10_000 },
  // Headless by default — passkey ceremony runs against a virtual
  // authenticator injected via CDP, no real user interaction needed.
  use: {
    baseURL: process.env.BASE_URL ?? 'https://relay.interego.xwisee.com',
    headless: true,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-passkey',
      use: { browserName: 'chromium' },
    },
  ],
  // CI: more retries, fewer workers (passkey tests touch shared pod state)
  retries: process.env.CI ? 2 : 0,
  workers: 1,
});
