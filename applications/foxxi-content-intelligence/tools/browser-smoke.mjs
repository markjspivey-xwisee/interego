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
  '/me',
  '/profile',
  // Canonical resource URLs — pluralized collections, opaque-uuid items
  '/profiles',
  '/profiles/bddde464-09a2-57bd-b5f1-eb052e63f974',  // Joshua
  '/profiles/4393084d-e1b7-5345-833c-635e2bdf6974',  // Jordan
  '/courses',
  '/courses/golf-explained',
  '/policies',
  '/groups',
  '/audit-records',
  '/coverage',
  '/integrations',
  '/statements',
  '/statements/aggregates',
  '/statements/conformance',
  '/lrs-config',
  '/agent-performance',
  // Legacy paths must redirect (not 404)
  '/learner',
  '/users/u-joshua',
  '/audit',
  '/admin/catalog',
  '/admin/lrs/statements',
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
const hypermediaCallsCase3 = [];
const mcpCallsCase3 = [];
page3.on('console', m => { if (m.type() === 'error') dashConsoleErr.push(m.text()); });
page3.on('pageerror', e => dashConsoleErr.push(`pageerror: ${e.message}`));
// Attach response listener BEFORE the page loads so we capture every
// /api/foxxi/v1/* fetch from first paint.
page3.on('response', resp => {
  const u = resp.url();
  if (u.includes('/api/foxxi/v1')) hypermediaCallsCase3.push({ url: u.replace(/.*\/api\/foxxi\/v1/, '/api/foxxi/v1'), status: resp.status() });
  // Track any /mcp JSON-RPC call from the dashboard. The Richardson Level 3
  // refactor's goal is for the dashboard to ride hypermedia + invokeAffordance
  // exclusively, so post-migration this count should be 0 (a single probe to
  // /affordances is allowed and tracked separately).
  if (resp.request().method() === 'POST' && /\/mcp(\/|$|\?)/.test(u)) {
    mcpCallsCase3.push({ url: u, status: resp.status() });
  }
});
await page3.goto(DASHBOARD, { waitUntil: 'networkidle', timeout: 30_000 });
await page3.evaluate(() => localStorage.clear());
await page3.reload({ waitUntil: 'networkidle' });
// Out-of-band auth: the launch URL must carry a one-time `code`, never
// the long-lived `bearer`. These are filled by Case 3 below.
let oobHasCode = false;
let oobHasBearer = true;
let oobPlayerPosts = 0;
let oobPlayerFailed = 0;
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
  console.log(`  hypermedia calls observed: ${hypermediaCallsCase3.length}`);
  for (const c of hypermediaCallsCase3.slice(0, 5)) console.log(`    · ${c.status} ${c.url}`);
  const hitEntryPoint = hypermediaCallsCase3.some(c => c.url === '/api/foxxi/v1' || c.url === '/api/foxxi/v1/');
  const hitProfile = hypermediaCallsCase3.some(c => /\/profiles\/[a-f0-9-]{36}$/.test(c.url));
  console.log(`  fetched entry-point /api/foxxi/v1: ${hitEntryPoint}`);
  console.log(`  fetched own profile via uuid: ${hitProfile}`);
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
      // Playwright may report 'about:blank' for the popup until it
      // navigates — wait for the real player URL to settle.
      await playerPage.waitForURL(/scorm-player/, { timeout: 15_000 }).catch(() => null);
      const playerUrl = playerPage.url();
      console.log(`  player tab opened: ${playerUrl.slice(0, 100)}…`);
      // Out-of-band auth: the URL must carry a single-use `code`, NOT the
      // long-lived session bearer (docs/patterns/out-of-band-auth-exchange.md).
      oobHasCode = /\bcode=[^&]+/.test(playerUrl);
      oobHasBearer = /\bbearer=[^&]+/.test(playerUrl);
      console.log(`  player URL carries one-time code: ${oobHasCode}`);
      console.log(`  player URL carries long-lived bearer: ${oobHasBearer} (expected false)`);
      const playerPosts = [];
      playerPage.on('response', resp => {
        if (resp.url().includes('/xapi/statements')) playerPosts.push({ status: resp.status() });
      });
      await playerPage.waitForLoadState('networkidle', { timeout: 30_000 });
      await playerPage.waitForTimeout(3000);
      const failedPlayerPosts = playerPosts.filter(r => r.status >= 400);
      oobPlayerPosts = playerPosts.length;
      oobPlayerFailed = failedPlayerPosts.length;
      console.log(`  player /xapi POSTs: ${playerPosts.length} total, ${failedPlayerPosts.length} failed`);
      console.log(`  expected: ≥3 POSTs after code→bearer exchange (launched + initialized + slide-viewed), 0 failed`);
    } else {
      console.log(`  ✗ Launch did not open a new tab`);
    }
  }
}
console.log(`  dashboard console errors: ${dashConsoleErr.length}`);
for (const e of dashConsoleErr.slice(0, 5)) console.log(`    · ${e}`);
console.log(`  /mcp POSTs from dashboard: ${mcpCallsCase3.length} (expected 0 — fully migrated to hypermedia)`);
for (const c of mcpCallsCase3.slice(0, 5)) console.log(`    · ${c.status} ${c.url}`);
await browser3.close();

const okNoMcp = mcpCallsCase3.length === 0;
console.log(`\n=== dashboard hypermedia purity: ${okNoMcp ? 'PASS' : 'FAIL'} — 0 /mcp POSTs observed ===`);

// Out-of-band auth: launch URL carries a one-time code, never the bearer,
// and the player still posts xAPI (proving the code→bearer exchange ran).
const okOob = oobHasCode && !oobHasBearer && oobPlayerPosts >= 3 && oobPlayerFailed === 0;
console.log(`\n=== out-of-band auth exchange: ${okOob ? 'PASS' : 'FAIL'} — code in URL, bearer absent, ${oobPlayerPosts} xAPI POSTs post-exchange ===`);

const okDeepLinks = deepLinkPass === deepLinks.length;
console.log(`\n=== deep-link routes: ${okDeepLinks ? 'PASS' : 'FAIL'} — ${deepLinkPass}/${deepLinks.length} served ===`);

// ── Case 5 — admin tabs are hypermedia-driven ──
// Sign in as Jordan (admin), visit each top-nav resource collection,
// confirm the page fetches the corresponding /api/foxxi/v1/<rel>
// hypermedia endpoint.
console.log('\n=== Case 5: every admin tab is hypermedia-driven ===');
const browser5 = await chromium.launch({ headless: true });
const ctx5 = await browser5.newContext();
const page5 = await ctx5.newPage();
const adminHmCalls = [];
page5.on('response', resp => {
  const u = resp.url();
  if (u.includes('/api/foxxi/v1')) adminHmCalls.push({ url: u.replace(/.*\/api\/foxxi\/v1/, '/api/foxxi/v1').split('?')[0], status: resp.status() });
});
await page5.goto(DASHBOARD, { waitUntil: 'networkidle', timeout: 30_000 });
await page5.evaluate(() => localStorage.clear());
await page5.reload({ waitUntil: 'networkidle' });
// Sign in as Jordan — admin role. Switch role tab first.
const adminRoleBtn = page5.locator('button:has-text("L&D administrator")').first();
if (await adminRoleBtn.count() > 0) await adminRoleBtn.click();
await page5.waitForTimeout(500);
const jordanBtn = page5.locator('button:has-text("Jordan Doe")').first();
const haveJordan = await jordanBtn.count();
console.log(`  Jordan sign-in button visible: ${haveJordan > 0}`);
if (haveJordan > 0) await jordanBtn.click();
else {
  // Fallback: just click the admin-side primary "Sign in as Jordan Doe" button
  const adminBtn = page5.locator('button:has-text("Sign in as Jordan Doe")').first();
  if (await adminBtn.count() > 0) await adminBtn.click();
}
await page5.waitForTimeout(4000);
const url5 = page5.url();
console.log(`  post-signin URL: ${url5}`);
const tabs = [
  { path: '/courses', expectedRel: '/api/foxxi/v1/courses' },
  { path: '/policies', expectedRel: '/api/foxxi/v1/policies' },
  { path: '/groups', expectedRel: '/api/foxxi/v1/groups' },
  { path: '/audit-records', expectedRel: '/api/foxxi/v1/audit-records' },
  { path: '/integrations', expectedRel: '/api/foxxi/v1/integrations' },
];
let tabPass = 0;
for (const t of tabs) {
  const before = adminHmCalls.length;
  await page5.goto(`${DASHBOARD}${t.path}`, { waitUntil: 'networkidle', timeout: 20_000 }).catch(() => null);
  await page5.waitForTimeout(2000);
  const newCalls = adminHmCalls.slice(before);
  const hit = newCalls.some(c => c.url === t.expectedRel && c.status === 200);
  if (hit) tabPass++;
  console.log(`  ${hit ? '✓' : '✗'} ${t.path.padEnd(20)} ${hit ? '→ ' + t.expectedRel : 'expected GET ' + t.expectedRel + ' (saw: ' + newCalls.map(c => c.url).join(', ') + ')'}`);
}
await browser5.close();
const okTabs = tabPass === tabs.length;
console.log(`\n=== admin-tab hypermedia: ${okTabs ? 'PASS' : 'FAIL'} — ${tabPass}/${tabs.length} ===`);

// ── Case 6 — IEEE P2997 Enterprise Learner Record ──
// Sign in as Joshua; the learner dashboard renders the Learner Record
// panel, which invokes foxxi.assemble_learner_record via hypermedia and
// shows the P2997 ELR — experiences + competencies + credentials +
// raw-data-location provenance.
console.log('\n=== Case 6: IEEE P2997 Enterprise Learner Record ===');
const browser6 = await chromium.launch({ headless: true });
const ctx6 = await browser6.newContext();
const page6 = await ctx6.newPage();
let elrAffordanceCalled = false;
let elrAffordanceStatus = 0;
let proveAffordanceCalled = false;
let proveAffordanceStatus = 0;
let perfAffordanceCalled = false;
let perfAffordanceStatus = 0;
page6.on('response', resp => {
  if (/\/foxxi\/assemble_learner_record/.test(resp.url())) {
    elrAffordanceCalled = true;
    elrAffordanceStatus = resp.status();
  }
  if (/\/foxxi\/prove_competency/.test(resp.url())) {
    proveAffordanceCalled = true;
    proveAffordanceStatus = resp.status();
  }
  if (/\/foxxi\/record_performance/.test(resp.url())) {
    perfAffordanceCalled = true;
    perfAffordanceStatus = resp.status();
  }
});
const elrConsoleErr = [];
page6.on('console', m => { if (m.type() === 'error') elrConsoleErr.push(m.text()); });
await page6.goto(DASHBOARD, { waitUntil: 'networkidle', timeout: 30_000 });
await page6.evaluate(() => localStorage.clear());
await page6.reload({ waitUntil: 'networkidle' });
const joshua6 = page6.locator('text=Joshua Liu').locator('..').locator('button:has-text("Sign in")').first();
let okElr = false;
let okSelectiveDisclosure = false;
let okPerformance = false;
if (await joshua6.count() > 0) {
  await joshua6.click();
  // Wait for the Learner Record card to render + its affordance call.
  await page6.waitForSelector('text=/Enterprise Learner Record/i', { timeout: 20_000 }).catch(() => null);
  await page6.waitForTimeout(6000);
  const cardPresent = await page6.locator('text=/Your Enterprise Learner Record/i').count() > 0;
  const p2997Pill = await page6.locator('text=IEEE P2997').count() > 0;
  const noElrError = !(await page6.locator('text=/✗ /').count() > 0);
  // The summary strip renders these labels only when the ELR resolved.
  const summaryRendered = await page6.locator('text=/Experiences/i').count() > 0
    && await page6.locator('text=/Verified competencies/i').count() > 0
    && await page6.locator('text=/Performance records/i').count() > 0;
  console.log(`  Learner Record card present: ${cardPresent}`);
  console.log(`  IEEE P2997 badge present: ${p2997Pill}`);
  console.log(`  assemble_learner_record affordance invoked: ${elrAffordanceCalled} (HTTP ${elrAffordanceStatus})`);
  console.log(`  ELR summary strip rendered: ${summaryRendered}`);
  console.log(`  no ELR error shown: ${noElrError}`);
  console.log(`  dashboard console errors: ${elrConsoleErr.length}`);
  okElr = cardPresent && p2997Pill && elrAffordanceCalled && elrAffordanceStatus === 200 && summaryRendered && noElrError;

  // Selective disclosure — click "Prove privately" and confirm the BBS+
  // zero-knowledge proof verifies (verifier confirmed ✓) end to end.
  const proveBtn = page6.locator('button:has-text("Prove privately")').first();
  if (await proveBtn.count() > 0) {
    await proveBtn.click();
    await page6.waitForSelector('text=/verifier confirmed/i', { timeout: 25_000 }).catch(() => null);
    await page6.waitForTimeout(1500);
    const verifiedShown = await page6.locator('text=/verifier confirmed/i').count() > 0;
    const disclosedShown = await page6.locator('text=/Disclosed to the verifier/i').count() > 0;
    const hiddenShown = await page6.locator('text=/Kept private/i').count() > 0;
    console.log(`  prove_competency affordance invoked: ${proveAffordanceCalled} (HTTP ${proveAffordanceStatus})`);
    console.log(`  BBS+ proof "verifier confirmed ✓" shown: ${verifiedShown}`);
    console.log(`  disclosed + hidden claim sections shown: ${disclosedShown && hiddenShown}`);
    okSelectiveDisclosure = proveAffordanceCalled && proveAffordanceStatus === 200
      && verifiedShown && disclosedShown && hiddenShown;
  } else {
    console.log('  ✗ "Prove privately" button not found');
  }

  // Performance — record a production-work event and confirm it lands in
  // the ELR as a performance record + yields a performance-verified
  // competency (the supersedes-weighted, on-the-job leg of P2997).
  const perfInput = page6.locator('input[placeholder*="task performed"]').first();
  const perfTaskName = `Smoke task ${Date.now()}`;
  if (await perfInput.count() > 0) {
    await perfInput.fill(perfTaskName);
    const recordBtn = page6.locator('button:has-text("Record success")').first();
    await recordBtn.click();
    await page6.waitForSelector(`text=${perfTaskName}`, { timeout: 20_000 }).catch(() => null);
    await page6.waitForTimeout(3000);
    const perfRowShown = await page6.locator(`text=${perfTaskName}`).count() > 0;
    const perfVerifiedPill = await page6.locator('text=performance-verified').count() > 0;
    console.log(`  record_performance affordance invoked: ${perfAffordanceCalled} (HTTP ${perfAffordanceStatus})`);
    console.log(`  performance record row shown in ELR: ${perfRowShown}`);
    console.log(`  performance-verified competency shown: ${perfVerifiedPill}`);
    okPerformance = perfAffordanceCalled && perfAffordanceStatus === 200 && perfRowShown && perfVerifiedPill;
  } else {
    console.log('  ✗ performance task input not found');
  }
} else {
  console.log('  ✗ Joshua sign-in button not found');
}
await browser6.close();
console.log(`\n=== learner record (IEEE P2997 ELR): ${okElr ? 'PASS' : 'FAIL'} ===`);
console.log(`=== selective disclosure (BBS+ competency proof): ${okSelectiveDisclosure ? 'PASS' : 'FAIL'} ===`);
console.log(`=== performance record → performance-verified competency: ${okPerformance ? 'PASS' : 'FAIL'} ===`);

// ── Case 7 — Agent Performance Consultant ──
// Seed a demo agent team's trajectories (API), then sign in as admin,
// open /agent-performance, read the disposition (Work-regime placement, no
// gap/score), run a safe-to-fail probe, and confirm the interventional + counterfactual
// causal read renders.
console.log('\n=== Case 7: Agent Performance Consultant (APT) ===');
let okAgentPerf = false;
let vocabDereferencedInProd = false;
const apToken = await mintSessionToken({ userId: USER_ID, webId: WEB_ID, ttlMs: 30 * 60 * 1000 });
const AP_TEAM = ['did:key:z6MkFoxxiResearchAgent', 'did:key:z6MkFoxxiRetrievalAgent', 'did:key:z6MkFoxxiSynthesisAgent'];
async function bridgeTool(name, args) {
  const r = await fetch(`${BRIDGE}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await r.json();
  return JSON.parse(j.result.content[0].text);
}
// Seed each demo agent with a trajectory carrying counterfactual branches
// (so the team reads as Complex).
for (const did of AP_TEAM) {
  await bridgeTool('foxxi.record_agent_trajectory', {
    agent_did: did, agent_name: did.split(':').pop(),
    steps: [
      { modal_status: 'Asserted', granularity: 'tool-call', verb: 'invoke', object_id: 'urn:tool:x', object_name: 'Use a tool', result: { success: true, quality: 0.9 } },
      { modal_status: 'Counterfactual', granularity: 'tool-call', verb: 'reject', object_id: 'urn:tool:y', object_name: 'Use an alternative tool' },
      { modal_status: 'Hypothetical', granularity: 'subtask', verb: 'intend', object_id: 'urn:sub:p', object_name: 'Plan' },
    ],
  });
}
console.log(`  seeded trajectories for ${AP_TEAM.length} demo agents`);
const browser7 = await chromium.launch({ headless: true });
const ctx7 = await browser7.newContext();
const page7 = await ctx7.newPage();
let apAssessCalled = false, apProbeCalled = false;
page7.on('response', resp => {
  if (/\/foxxi\/assess_agent_disposition/.test(resp.url())) apAssessCalled = true;
  if (/\/foxxi\/run_performance_probe/.test(resp.url())) apProbeCalled = true;
});
await page7.goto(DASHBOARD, { waitUntil: 'networkidle', timeout: 30_000 });
await page7.evaluate(() => localStorage.clear());
await page7.reload({ waitUntil: 'networkidle' });
const adminRole7 = page7.locator('button:has-text("L&D administrator")').first();
if (await adminRole7.count() > 0) await adminRole7.click();
await page7.waitForTimeout(400);
const jordan7 = page7.locator('button:has-text("Jordan Doe")').first();
if (await jordan7.count() > 0) {
  await jordan7.click();
  await page7.waitForTimeout(3000);
  await page7.goto(`${DASHBOARD}/agent-performance`, { waitUntil: 'networkidle', timeout: 20_000 });
  const panelPresent = await page7.locator('text=/Agent Performance Consultant/i').count() > 0;
  const aptBadge = await page7.locator('text=/complexity-aware/i').count() > 0;
  await page7.locator('button:has-text("Read disposition")').first().click();
  await page7.waitForSelector('text=/Work-regime placement/i', { timeout: 20_000 }).catch(() => null);
  await page7.waitForTimeout(2000);
  const regimeShown = await page7.locator('text=/Work-regime placement/i').count() > 0;
  const noScore = await page7.locator('text=/no score, no gap/i').count() > 0;
  await page7.locator('button:has-text("Run probe")').first().click();
  await page7.waitForSelector('text=/Causal read/i', { timeout: 20_000 }).catch(() => null);
  await page7.waitForTimeout(2000);
  const causalShown = await page7.locator('text=/Causal read/i').count() > 0;
  const rungShown = await page7.locator('text=/Rung 2/i').count() > 0;
  console.log(`  consultant panel present: ${panelPresent} · APT badge: ${aptBadge}`);
  console.log(`  assess_agent_disposition invoked: ${apAssessCalled} · Work-regime placement shown: ${regimeShown}`);
  console.log(`  "no score, no gap" framing present: ${noScore}`);
  console.log(`  run_performance_probe invoked: ${apProbeCalled} · causal read (rung 2/3) shown: ${causalShown && rungShown}`);
  okAgentPerf = panelPresent && aptBadge && apAssessCalled && regimeShown && noScore
    && apProbeCalled && causalShown && rungShown;

  // While signed in as the admin, open the LRS Conformance tab — its
  // check ACTUALLY dereferences the foxxi vocabulary (a live GET), and
  // the tab surfaces whether that dereference succeeded.
  await page7.goto(`${DASHBOARD}/statements/conformance`, { waitUntil: 'networkidle', timeout: 20_000 }).catch(() => null);
  await page7.waitForSelector('text=/vocabulary dereferenced/i', { timeout: 15_000 }).catch(() => null);
  await page7.waitForTimeout(1500);
  vocabDereferencedInProd = await page7.locator('text=/✓ vocabulary dereferenced/i').count() > 0;
  console.log(`  conformance tab confirms the vocab was dereferenced in production: ${vocabDereferencedInProd}`);
} else {
  console.log('  ✗ Jordan sign-in button not found');
}
await browser7.close();
console.log(`\n=== Agent Performance Consultant (APT): ${okAgentPerf ? 'PASS' : 'FAIL'} ===`);

// ── Case 8 — Foxxi vocabulary is dereferenceable linked data ──
// Not just an RDF namespace: the bridge SERVES it, every term IRI
// resolves, and a production path (the conformance check) actually
// dereferences it.
console.log('\n=== Case 8: Foxxi vocabulary — dereferenceable RESTful linked data ===');
let okVocab = false;
try {
  const ep = await (await fetch(`${BRIDGE}/api/foxxi/v1`, { headers: { Accept: 'application/json' } })).json();
  const vocabLink = ep._links?.['foxxi-vocabulary']?.href;
  const vocabRes = await fetch(`${BRIDGE}/ns/foxxi`, { headers: { Accept: 'application/ld+json' } });
  const vocab = await vocabRes.json();
  const terms = Array.isArray(vocab.terms) ? vocab.terms : [];
  const hasAffordanceInvoked = terms.some(t => String(t['@id']).endsWith('#verbs/affordance-invoked'));
  // Dereference a single verb as its own RESTful resource.
  const termRes = await fetch(`${BRIDGE}/ns/foxxi/term/verbs/affordance-invoked`, { headers: { Accept: 'application/ld+json' } });
  const term = await termRes.json();
  const termOk = termRes.status === 200 && typeof term.comment === 'string' && !!term._links?.vocabulary;
  // Turtle content negotiation.
  const ttlRes = await fetch(`${BRIDGE}/ns/foxxi`, { headers: { Accept: 'text/turtle' } });
  const ttl = await ttlRes.text();
  const ttlOk = ttlRes.status === 200 && ttl.includes('foxxi:') && ttl.includes('rdfs:comment');
  // The xAPI Profile's `id` IS the URL it is served at — it dereferences
  // to itself; its templates/patterns are their own resources.
  const profRes = await fetch(`${BRIDGE}/xapi/profile`, { headers: { Accept: 'application/ld+json' } });
  const prof = await profRes.json();
  const profSelfConsistent = profRes.status === 200 && prof.id === `${BRIDGE}/xapi/profile`;
  const tplRes = await fetch(`${BRIDGE}/xapi/profile/templates/launched`, { headers: { Accept: 'application/ld+json' } });
  const tpl = await tplRes.json();
  const tplOk = tplRes.status === 200 && tpl.id === `${BRIDGE}/xapi/profile/templates/launched` && !!tpl._links?.profile;
  console.log(`  entry-point advertises foxxi-vocabulary link: ${!!vocabLink}`);
  console.log(`  GET /ns/foxxi → HTTP ${vocabRes.status}, ${terms.length} terms, affordance-invoked present: ${hasAffordanceInvoked}`);
  console.log(`  single verb dereferences as a RESTful resource: ${termOk}`);
  console.log(`  Turtle content negotiation works: ${ttlOk}`);
  console.log(`  xAPI Profile id dereferences to itself: ${profSelfConsistent}`);
  console.log(`  profile template dereferences as its own resource: ${tplOk}`);
  console.log(`  conformance check actually dereferenced the vocab in production: ${vocabDereferencedInProd} (Case 7, admin session)`);
  // The IEEE-LER + ADL-TLA emergent composable semantic layer — both
  // ontologies dereference, and composed/view terms carry the
  // cg:constructedFrom triples that make the composition machine-readable.
  let semOk = true;
  for (const slug of ['ieee-ler', 'adl-tla']) {
    const r = await fetch(`${BRIDGE}/ns/${slug}`, { headers: { Accept: 'application/ld+json' } });
    const doc = await r.json();
    const t = Array.isArray(doc.terms) ? doc.terms : [];
    const composed = t.filter(x => ['composed', 'view', 'role'].includes(x.construction)
      && Array.isArray(x.constructedFrom) && x.constructedFrom.length > 0);
    const ttlR = await fetch(`${BRIDGE}/ns/${slug}`, { headers: { Accept: 'text/turtle' } });
    const ttlBody = await ttlR.text();
    const slugOk = r.status === 200 && t.length > 20 && composed.length > 0
      && ttlR.status === 200 && ttlBody.includes('cg:constructedFrom');
    console.log(`  GET /ns/${slug} → HTTP ${r.status}, ${t.length} terms, ${composed.length} emergent (composed/view/role): ${slugOk}`);
    if (!slugOk) semOk = false;
  }
  okVocab = !!vocabLink && vocabRes.status === 200 && terms.length > 10 && hasAffordanceInvoked
    && termOk && ttlOk && profSelfConsistent && tplOk && vocabDereferencedInProd && semOk;
} catch (err) {
  console.log(`  ✗ ${err.message}`);
}
console.log(`\n=== Foxxi vocabulary + LER/TLA semantic layer dereferenceable: ${okVocab ? 'PASS' : 'FAIL'} ===`);

const ok = okAuthed && okAnon && okDeepLinks && okTabs && okNoMcp && okOob && okElr && okSelectiveDisclosure && okPerformance && okAgentPerf && okVocab;
console.log(`\n=== overall: ${ok ? 'PASS' : 'FAIL'} ===`);
process.exit(ok ? 0 : 1);
