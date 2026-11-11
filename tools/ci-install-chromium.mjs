#!/usr/bin/env node
/**
 * Install Playwright's Chromium on a CI runner, and prove it launches.
 *
 * `npx playwright install --with-deps chromium` is two things: an apt install of Chromium's system
 * packages, and the browser download. On 2026-11-11 the runners could not resolve the Ubuntu
 * package mirror for about two hours ("Temporary failure resolving 'azure.archive.ubuntu.com'").
 * The apt half then failed on nine optional font packages, after ten minutes of apt's own retries,
 * every shared library Chromium needs being already on the runner image. The browser was never
 * downloaded and no test ran, on master and on every pull request, until the mirror came back.
 *
 * So the two halves are separated, and what decides the step is whether the browser works:
 *
 *   1. The system packages are installed, within a time limit (DEPS_TIMEOUT_MS). A failure or a
 *      timeout here is a warning, not the step's result.
 *   2. The browser is downloaded, up to DOWNLOAD_ATTEMPTS times. Without it nothing can run: a
 *      download that never succeeds fails the step.
 *   3. Chromium is launched headless and renders a page. A runner that really lacks a library fails
 *      here, with the launcher's own message naming it, whatever step 1 said.
 *
 * Nothing is skipped and no test is weakened: the tests that follow run against a browser this
 * script has just launched. What is given up is only the font packages when the mirror is down,
 * and that is said in the log (a `::warning::` annotation).
 *
 * Runs from any directory in which `playwright` resolves (the repository root, or a workspace).
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const DEPS_TIMEOUT_MS = 3 * 60 * 1000;
export const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

/** Run `npx playwright <args>`; true when it exited 0 within `timeout`. */
function playwright(args, timeout) {
  const result = spawnSync(npx, ['playwright', ...args], { stdio: 'inherit', timeout });
  if (result.error) console.error(`playwright ${args.join(' ')}: ${result.error.message}`);
  return result.status === 0;
}

/**
 * The outcome of an install, from what each half did: `run(args, timeout)` is the Playwright CLI,
 * `launch()` resolves once a headless Chromium has rendered a page and rejects otherwise, `pause(ms)`
 * waits between download attempts. Exported so the decision is tested without a network or a browser.
 */
export async function installChromium({ run, launch, pause, warn }) {
  const deps = run(['install-deps', 'chromium'], DEPS_TIMEOUT_MS);
  if (!deps) warn('Chromium system packages were not all installed (the package mirror failed or timed out). Continuing: the launch check below decides.');
  let downloaded = false;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS && !downloaded; attempt++) {
    downloaded = run(['install', 'chromium'], DOWNLOAD_TIMEOUT_MS);
    if (!downloaded && attempt < DOWNLOAD_ATTEMPTS) await pause(attempt * 10_000);
  }
  if (!downloaded) return { ok: false, deps, reason: `the Chromium download failed ${DOWNLOAD_ATTEMPTS} times` };
  try { await launch(); }
  catch (error) { return { ok: false, deps, reason: `Chromium does not launch: ${error instanceof Error ? error.message : String(error)}` }; }
  return { ok: true, deps };
}

/** Launch the installed Chromium headless and render a page; rejects when it cannot. */
async function launchCheck() {
  const require = createRequire(path.join(process.cwd(), 'noop.js'));
  const { chromium } = await import(pathToFileURL(require.resolve('playwright')).href).then(module => module.default ?? module);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<p id="ok">chromium</p>');
    if (await page.textContent('#ok') !== 'chromium') throw new Error('the page did not render');
  } finally { await browser.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outcome = await installChromium({
    run: playwright, launch: launchCheck,
    pause: ms => new Promise(resolve => setTimeout(resolve, ms)),
    warn: message => console.log(`::warning title=Chromium system packages::${message}`),
  });
  if (!outcome.ok) { console.error(`::error title=Chromium install::${outcome.reason}`); process.exit(1); }
  console.log(`Chromium is installed and launches${outcome.deps ? '' : ' (without the system packages the mirror could not serve)'}.`);
}
