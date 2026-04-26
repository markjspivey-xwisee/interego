#!/usr/bin/env node
/**
 * security-txt-expiry-check — fail CI when /.well-known/security.txt
 * is within the 30-day refresh window.
 *
 * RFC 9116 §2.5.5 requires Expires ≤ 1 year. spec/policies/14-vulnerability-management.md §5.3
 * commits the operator to refreshing annually. This check enforces the
 * commitment in CI: at 30 days to expiry, the build fails so the
 * refresh actually happens before researchers hit a stale file.
 *
 * Reads the Expires field from src/security-txt/index.ts (the shared
 * helper's DEFAULT_EXPIRES constant) and exits non-zero if the
 * threshold is breached.
 *
 * Usage: node tools/security-txt-expiry-check.mjs [--days N]
 *
 * Exit codes: 0 = OK; 1 = within threshold (refresh required); 2 = parse error.
 */

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const dayThresholdIdx = args.indexOf('--days');
const dayThreshold = dayThresholdIdx >= 0 ? parseInt(args[dayThresholdIdx + 1], 10) : 30;

let src;
try {
  src = readFileSync('src/security-txt/index.ts', 'utf8');
} catch (err) {
  console.error('Could not read src/security-txt/index.ts:', err.message);
  process.exit(2);
}

const m = src.match(/const DEFAULT_EXPIRES\s*=\s*['"](\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)['"]/);
if (!m) {
  console.error('Could not find DEFAULT_EXPIRES constant in src/security-txt/index.ts.');
  console.error('Expected: const DEFAULT_EXPIRES = "YYYY-MM-DDTHH:MM:SSZ"');
  process.exit(2);
}

const expires = new Date(m[1]);
const now = new Date();
const msPerDay = 24 * 60 * 60 * 1000;
const daysToExpiry = Math.floor((expires.getTime() - now.getTime()) / msPerDay);

if (daysToExpiry < 0) {
  console.error(`✗ security.txt EXPIRED ${-daysToExpiry} days ago (Expires: ${m[1]}).`);
  console.error('  Bump DEFAULT_EXPIRES in src/security-txt/index.ts and update the policy review record.');
  process.exit(1);
}

if (daysToExpiry < dayThreshold) {
  console.error(`✗ security.txt expires in ${daysToExpiry} days (threshold: ${dayThreshold}).`);
  console.error('  Refresh per spec/policies/14-vulnerability-management.md §5.3.');
  console.error(`  Bump DEFAULT_EXPIRES in src/security-txt/index.ts.`);
  process.exit(1);
}

console.log(`✓ security.txt valid for ${daysToExpiry} more days (Expires: ${m[1]}).`);
process.exit(0);
