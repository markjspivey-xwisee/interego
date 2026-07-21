/**
 * Headless browser smoke for the Performance & Knowledge Architecture
 * demo suite — verifies the panel renders in a real browser and routes
 * all 16 flows live against the deployed bridge.
 *
 *   npx tsx tools/demo-suite-smoke.mjs
 *
 * Injects a dashboard session, opens /demo-suite, clicks "Route all 16
 * flows", and confirms the matrix populates with intervention results.
 * Exits non-zero on any failure or uncaught page error.
 */

import { chromium } from 'playwright';
import { mintSessionToken } from '../src/auth.ts';

const DASH = process.env.FOXXI_DASHBOARD_URL
  ?? 'https://foxxi-dashboard.interego.xwisee.com';
const WEB_ID = 'https://acme-id.interego.xwisee.com/users/jliu/profile/card#me';
const POD = 'https://gate.interego.xwisee.com/foxxi/';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
};

console.log('=== Demo-suite browser smoke ===\n');

const token = await mintSessionToken({ userId: 'u-joshua', webId: WEB_ID, ttlMs: 30 * 60 * 1000 });
const session = {
  role: 'admin', webId: WEB_ID, userId: 'u-joshua', name: 'Joshua Liu',
  audienceTags: ['learning-engineering'], tenantPodUrl: POD,
  bearerToken: token, bearerExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
await ctx.addInitScript(s => window.localStorage.setItem('foxxi:session', s), JSON.stringify(session));
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()); });

try {
  await page.goto(`${DASH}/demo-suite`, { waitUntil: 'networkidle', timeout: 40_000 });

  const titleVisible = await page.locator('text=Performance & Knowledge Architecture').count() > 0;
  check('the demo-suite panel renders', titleVisible);

  const navVisible = await page.locator('text=Demo suite').count() > 0;
  check('the "Demo suite" nav link is present', navVisible);

  // The 4x4 matrix — 16 scenario cells (buttons with "click to route").
  const cellCount = await page.locator('button:has-text("click to route")').count();
  check('the 4x4 matrix renders 16 cells', cellCount === 16, cellCount);

  // Route all 16 flows.
  await page.click('text=Route all 16 flows');
  await page.waitForSelector('text=/16\\/16 flows routed/', { timeout: 90_000 });
  check('all 16 flows route to completion', true);

  // The summary readout — content vs non-content.
  const summary = await page.locator('text=/routed to/').first().textContent().catch(() => '');
  check('the content/non-content summary is shown', /content/.test(summary ?? ''), summary);

  // Open one cell and confirm the full flow detail renders.
  await page.locator('button:has-text("Refund dispute resolution")').first().click();
  await page.waitForSelector('text=The intervention paradigm', { timeout: 20_000 });
  const paradigmRows = await page.locator('text=/✓|✗/').count();
  check('a selected cell shows the full intervention paradigm', paradigmRows >= 9, paradigmRows);
  const knowledgeShown = await page.locator('text=Knowledge map').count() > 0;
  check('the selected flow shows the knowledge map', knowledgeShown);

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3));
} catch (err) {
  fail++;
  console.log(`  ✗ smoke threw — ${err.message}`);
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('\nThe demo suite renders and routes all 16 directionality x regime flows live.');
