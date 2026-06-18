#!/usr/bin/env node
/**
 * xAPI 2.0 Conformance Smoke Runner for Foxxi-as-LRS (CLI).
 *
 * Thin CLI over the SHARED runner: the 26 conformance checks live ONCE in
 * src/compliance-runner.ts (`runXapiConformance`), which the bridge's
 * GET /compliance/xapi/run endpoint and the public compliance microsite also
 * call. CLI + bridge endpoint + microsite therefore share a single source of
 * truth for what "xAPI 2.0 conformant" means — edit the checks in one place.
 *
 * Exercises every endpoint of the Foxxi LRS surface against expected behavior
 * per IEEE 9274.1.1 (xAPI 2.0):
 *   §3.1 version negotiation · §4.1 statement POST + required fields ·
 *   §4.1.1 immutability · §4.1.7 voiding · §4.2 filtered queries + cursor ·
 *   §6.3 State ETag concurrency · §7.7 /about · xAPI Profile Spec 2017 shape.
 *
 * Run (against any deployment of the bridge):
 *   FOXXI_BRIDGE_URL=https://your-bridge  npx tsx tools/xapi-conformance-smoke.mjs
 *
 * Authenticates with a wallet-signed session token (the same shape the
 * dashboard mints). Exit 0 on full pass, 1 if any check fails.
 */
import { mintSessionToken } from '../src/auth.ts';
import { runXapiConformance } from '../src/compliance-runner.ts';

const BRIDGE = process.env.FOXXI_BRIDGE_URL
  ?? 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const WEB_ID = process.env.FOXXI_TEST_WEBID
  ?? 'https://interego-acme-id.livelysky-8b81abb0.eastus.azurecontainerapps.io/users/jliu/profile/card#me';
const USER_ID = process.env.FOXXI_TEST_USERID ?? 'u-joshua';

const token = await mintSessionToken({ userId: USER_ID, webId: WEB_ID, ttlMs: 30 * 60 * 1000 });
const report = await runXapiConformance({
  baseUrl: BRIDGE, token, webId: WEB_ID, userId: USER_ID, ranAt: new Date().toISOString(),
});

console.log(`\n=== xAPI 2.0 Conformance Smoke against ${BRIDGE} ===\n`);
for (const c of report.checks) {
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(60)} (${c.spec})${c.detail ? ' — ' + c.detail : ''}`);
}
console.log(`\n=== ${report.passed} passed / ${report.failed} failed (${report.total} checks total) ===`);
if (report.failed > 0) {
  console.log('\nFailing checks:');
  for (const c of report.checks.filter(x => !x.ok)) {
    console.log(`  ✗ ${c.name} (${c.spec})${c.detail ? ' — ' + c.detail : ''}`);
  }
  process.exit(1);
}
