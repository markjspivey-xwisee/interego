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
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Headless by default — passkey ceremony runs against a virtual
  // authenticator injected via CDP, no real user interaction needed.
  use: {
    baseURL: process.env.BASE_URL ?? 'https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io',
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
