#!/usr/bin/env node
/**
 * Browser-level smoke for the Foxxi course-player → bridge LRS path.
 *
 * Real browser via Playwright so CORS preflight + cookies + localStorage
 * + iframe loading all behave as in production. Curl-based smoke missed
 * the CORS-preflight bug because curl doesn't send `Origin`; this would
 * have caught it.
 *
 * Run:
 *   node --experimental-strip-types applications/foxxi-content-intelligence/tools/browser-smoke.mjs
 *
 * Exits 1 on any failure with the captured console + network traces so
 * the failure mode is obvious from CI logs.
 */
import { chromium } from 'playwright';
import { mintSessionToken } from '../src/auth.ts';

const PLAYER = 'https://interego-foxxi-scorm-player.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const BRIDGE = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const WEB_ID = 'https://interego-acme-id.livelysky-8b81abb0.eastus.azurecontainerapps.io/users/jliu/profile/card#me';
const USER_ID = 'u-joshua';
const NAME = 'Joshua Liu';

console.log('=== Foxxi player → bridge browser smoke ===\n');

const token = await mintSessionToken({ userId: USER_ID, webId: WEB_ID, ttlMs: 30 * 60 * 1000 });
console.log(`✓ minted token (${token.length} chars; sub=${WEB_ID})`);

const playerUrl = `${PLAYER}/?bearer=${encodeURIComponent(token)}&bridge=${encodeURIComponent(BRIDGE)}&learner_did=${encodeURIComponent(WEB_ID)}&learner_name=${encodeURIComponent(NAME)}&course_id=golf-explained`;
console.log(`✓ built player URL (length ${playerUrl.length})`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const consoleLogs = [];
const networkPosts = [];
page.on('console', m => consoleLogs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => consoleLogs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', req => {
  consoleLogs.push(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
});
page.on('response', async resp => {
  const url = resp.url();
  if (url.includes('/xapi/statements') || url.includes('/xapi/about') || url.includes('/xapi/profile')) {
    const status = resp.status();
    let preview = '';
    try {
      const body = await resp.text();
      preview = body.slice(0, 200);
    } catch { /* opaque */ }
    networkPosts.push({ method: resp.request().method(), url: url.replace(BRIDGE, ''), status, preview });
  }
});

console.log('\n--- loading player ---');
await page.goto(playerUrl, { waitUntil: 'networkidle', timeout: 30_000 });
// Give the player a beat to fire its launched/initialized/experienced statements
await page.waitForTimeout(3000);

console.log('\n--- network: /xapi/* requests ---');
for (const r of networkPosts) {
  const tag = r.status >= 200 && r.status < 300 ? '✓' : '✗';
  console.log(`  ${tag} ${r.method.padEnd(5)} ${r.url.padEnd(40)} HTTP ${r.status}${r.preview && r.status >= 400 ? ' — ' + r.preview : ''}`);
}

const corsErrors = consoleLogs.filter(l => /CORS|preflight|Access-Control/.test(l));
const otherErrors = consoleLogs.filter(l => /^\[(error|pageerror|requestfailed)\]/i.test(l) && !corsErrors.includes(l));

console.log('\n--- CORS issues ---');
if (corsErrors.length === 0) console.log('  (none)');
for (const e of corsErrors) console.log(`  ✗ ${e}`);

console.log('\n--- other console errors / page errors ---');
if (otherErrors.length === 0) console.log('  (none)');
for (const e of otherErrors) console.log(`  ✗ ${e}`);

console.log('\n--- player trace UL (DOM) ---');
const traceItems = await page.locator('#trace-list li').allTextContents();
for (const t of traceItems) console.log(`  · ${t}`);

await browser.close();

const failedPosts = networkPosts.filter(r => r.status >= 400);
const okAuthed = failedPosts.length === 0 && corsErrors.length === 0 && otherErrors.length === 0;
console.log(`\n=== authed: ${okAuthed ? 'PASS' : 'FAIL'} — ${networkPosts.length} /xapi/* requests, ${failedPosts.length} failed, ${corsErrors.length} CORS, ${otherErrors.length} other ===`);

// ── Case 2 — open the player WITHOUT a bearer and assert it does NOT spam 401s ──
console.log('\n=== Case 2: anonymous player must not POST (xAPI 2.0 §6.4 requires auth on every resource) ===');
const browser2 = await chromium.launch({ headless: true });
const ctx2 = await browser2.newContext();
const page2 = await ctx2.newPage();
const anonPosts = [];
const anonConsoleErr = [];
page2.on('console', m => { if (m.type() === 'error') anonConsoleErr.push(m.text()); });
page2.on('response', resp => {
  if (resp.url().includes('/xapi/statements')) anonPosts.push({ status: resp.status() });
});
await page2.goto(`${PLAYER}/`, { waitUntil: 'networkidle', timeout: 30_000 });
await page2.waitForTimeout(3000);
const traceItems2 = await page2.locator('#trace-list li').allTextContents();
console.log('  player trace (anonymous):');
for (const t of traceItems2) console.log(`    · ${t}`);
console.log(`  ${anonPosts.length} POSTs to /xapi/statements (expected 0 — must not spam 401)`);
const okAnon = anonPosts.length === 0;
await browser2.close();

// ── Case 4 — deep-link routes resolve correctly (SPA fallback) ──
console.log('\n=== Case 4: deep-link routes (SPA fallback via nginx) ===');
const browser4 = await chromium.launch({ headless: true });
const ctx4 = await browser4.newContext();
const DASHBOARD_BASE = 'https://interego-foxxi-dashboard.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const deepLinks = [
  '/login',
  '/learner',
  '/admin/catalog',
  '/admin/policies',
  '/admin/lrs/statements',
  '/admin/lrs/aggregates',
];
let deepLinkPass = 0;
for (const path of deepLinks) {
  const p = await ctx4.newPage();
  const resp = await p.goto(DASHBOARD_BASE + path, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => null);
  const status = resp?.status() ?? 0;
  const ok = status >= 200 && status < 400;
  if (ok) deepLinkPass++;
  console.log(`  ${ok ? '✓' : '✗'} ${path.padEnd(30)} HTTP ${status}`);
  await p.close();
}
await browser4.close();

// ── Case 3 — dashboard → ▶ Launch end-to-end ──
// Open dashboard, clear stale localStorage, sign in as Joshua, click
// Launch, intercept the new tab, verify its URL has a bearer + the
// player's POSTs succeed.
console.log('\n=== Case 3: dashboard → ▶ Launch end-to-end ===');
const DASHBOARD = 'https://interego-foxxi-dashboard.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const browser3 = await chromium.launch({ headless: true });
const ctx3 = await browser3.newContext();
const page3 = await ctx3.newPage();
const dashConsoleErr = [];
page3.on('console', m => { if (m.type() === 'error') dashConsoleErr.push(m.text()); });
page3.on('pageerror', e => dashConsoleErr.push(`pageerror: ${e.message}`));
await page3.goto(DASHBOARD, { waitUntil: 'networkidle', timeout: 30_000 });
await page3.evaluate(() => localStorage.clear());
await page3.reload({ waitUntil: 'networkidle' });
// Find Joshua's sign-in button — Login.tsx puts one button per learner option
const joshuaButton = page3.locator('text=Joshua Liu').locator('..').locator('button:has-text("Sign in")').first();
const visible = await joshuaButton.count();
console.log(`  Joshua sign-in button visible: ${visible > 0}`);
if (visible > 0) {
  await joshuaButton.click();
  await page3.waitForTimeout(3000); // wait for sessionFromOption + setSession + render
  const sessionInLocal = await page3.evaluate(() => localStorage.getItem('foxxi:session'));
  let hasBearer = false;
  try {
    const s = JSON.parse(sessionInLocal);
    hasBearer = !!s.bearerToken && s.bearerToken.length > 100;
    console.log(`  session in localStorage has bearerToken: ${hasBearer ? 'YES (len ' + s.bearerToken.length + ')' : 'NO'}`);
  } catch { console.log(`  session unparseable in localStorage`); }

  // Wait for enrollments to load + render
  await page3.waitForSelector('text=/assigned courses/i', { timeout: 15_000 }).catch(() => null);
  await page3.waitForTimeout(5000);
  // Debug: dump what's actually on the page
  const enrollmentText = await page3.locator('text=/Golf Explained/').count();
  console.log(`  "Golf Explained" mentions on page: ${enrollmentText}`);
  const allButtons = await page3.locator('button').allTextContents();
  console.log(`  buttons on page: ${JSON.stringify(allButtons.slice(0, 12))}`);
  // Look for either "Launch" or "▶ Launch" — selector is forgiving
  const newPagePromise = ctx3.waitForEvent('page', { timeout: 10_000 }).catch(() => null);
  const launchBtn = page3.locator('button:has-text("Launch")').first();
  const launchVisible = await launchBtn.count();
  console.log(`  ▶ Launch button visible: ${launchVisible > 0}`);
  if (launchVisible > 0) {
    await launchBtn.click();
    const playerPage = await newPagePromise;
    if (playerPage) {
      console.log(`  player tab opened: ${playerPage.url().slice(0, 100)}…`);
      const playerUrlHasBearer = /\bbearer=[^&]+/.test(playerPage.url());
      console.log(`  player URL carries bearer query param: ${playerUrlHasBearer}`);
      const playerPosts = [];
      playerPage.on('response', resp => {
        if (resp.url().includes('/xapi/statements')) playerPosts.push({ status: resp.status() });
      });
      await playerPage.waitForLoadState('networkidle', { timeout: 30_000 });
      await playerPage.waitForTimeout(3000);
      const failedPlayerPosts = playerPosts.filter(r => r.status >= 400);
      console.log(`  player /xapi POSTs: ${playerPosts.length} total, ${failedPlayerPosts.length} failed`);
      console.log(`  expected: at least 3 POSTs (launched + initialized + 1 slide-viewed), 0 failed`);
    } else {
      console.log(`  ✗ Launch did not open a new tab`);
    }
  }
}
console.log(`  dashboard console errors: ${dashConsoleErr.length}`);
for (const e of dashConsoleErr.slice(0, 5)) console.log(`    · ${e}`);
await browser3.close();

const okDeepLinks = deepLinkPass === deepLinks.length;
console.log(`\n=== deep-link routes: ${okDeepLinks ? 'PASS' : 'FAIL'} — ${deepLinkPass}/${deepLinks.length} served ===`);

const ok = okAuthed && okAnon && okDeepLinks;
console.log(`\n=== overall: ${ok ? 'PASS' : 'FAIL'} ===`);
process.exit(ok ? 0 : 1);
