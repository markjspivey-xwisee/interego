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
 * Reads the Expires field from the shared helper's DEFAULT_EXPIRES
 * constant and exits non-zero if the threshold is breached.
 *
 * ★ THIS GUARD SPENT ITS WHOLE LIFE EXITING 2 AND NOBODY SAW IT.
 *
 * It read `src/security-txt/index.ts`. That path stopped existing when the helper became a
 * workspace package at `packages/security-txt/src/index.ts`, so every invocation died in
 * the `catch` below with exit 2 — and the RFC 9116 Expires value it exists to check was
 * never once evaluated. `npm run lint:all`, the composite gate that chains it, therefore
 * exited 2 on a CLEAN TREE at HEAD, and that was invisible because no workflow ran either
 * one: CI ran the narrower `npm run lint`.
 *
 * Two things had to be true for that to hide for as long as it did — a stale path AND no
 * CI reach — so both are fixed: the path is a single named constant below, and
 * `.github/workflows/ontology-lint.yml` now runs this alongside the other tools/ linters.
 * A guard nothing runs is a comment.
 *
 * ★ AND THE PATH IS RESOLVED FROM import.meta.url, NOT FROM process.cwd(). Correcting the
 * literal left half the defect standing: `readFileSync('packages/security-txt/src/index.ts')`
 * is resolved against the CALLER's directory, so running this from `tools/` looked for
 * `tools/packages/security-txt/src/index.ts` and exited 2 again — measured, on this tree,
 * after the path fix had landed. Every other gate here already anchors on import.meta.url
 * (lint-gate.mjs, typecheck-gate.mjs, derivation-lint.mjs, ontology-lint.mjs); this one did
 * not, and "exit 2 from the wrong directory" reads identically to "the helper moved again".
 *
 * ★ AND A BAD --days VALUE IS FATAL, NOT SILENTLY DISABLING. `parseInt('soon', 10)` is NaN
 * and `daysToExpiry < NaN` is false for EVERY input, so `--days soon` (or `--days` with no
 * value) printed the ✓ line and exited 0 for any expiry date whatsoever — measured. A guard
 * that can be switched off by a typo, while still looking like it ran, is the fail-open shape
 * this file's own header is about.
 *
 * Usage: node tools/security-txt-expiry-check.mjs [--days N]
 *
 * Exit codes: 0 = OK; 1 = within threshold (refresh required); 2 = cannot check.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This file lives in `tools/`, so its parent directory is the repo root. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Single source of the path, so a future move breaks one line and not four messages. */
const SOURCE = 'packages/security-txt/src/index.ts';
const SOURCE_PATH = join(ROOT, SOURCE);

const args = process.argv.slice(2);
const dayThresholdIdx = args.indexOf('--days');
let dayThreshold = 30;
if (dayThresholdIdx >= 0) {
  dayThreshold = parseInt(args[dayThresholdIdx + 1], 10);
  if (!Number.isFinite(dayThreshold) || dayThreshold < 0) {
    console.error(
      `Invalid --days value: ${JSON.stringify(args[dayThresholdIdx + 1])}. Expected a non-negative integer.`,
    );
    console.error('  Refusing to run: NaN compares false against every date, so an unparsed');
    console.error('  threshold would have disabled this guard while still printing its ✓ line.');
    process.exit(2);
  }
}

let src;
try {
  src = readFileSync(SOURCE_PATH, 'utf8');
} catch (err) {
  console.error(`Could not read ${SOURCE}:`, err.message);
  console.error('  The helper moved. Update SOURCE in tools/security-txt-expiry-check.mjs —');
  console.error('  this exit-2 means the Expires value was NOT checked, not that it is fine.');
  process.exit(2);
}

const m = src.match(/const DEFAULT_EXPIRES\s*=\s*['"](\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)['"]/);
if (!m) {
  console.error(`Could not find DEFAULT_EXPIRES constant in ${SOURCE}.`);
  console.error('Expected: const DEFAULT_EXPIRES = "YYYY-MM-DDTHH:MM:SSZ"');
  process.exit(2);
}

const expires = new Date(m[1]);
const now = new Date();
const msPerDay = 24 * 60 * 60 * 1000;
const daysToExpiry = Math.floor((expires.getTime() - now.getTime()) / msPerDay);

if (daysToExpiry < 0) {
  console.error(`✗ security.txt EXPIRED ${-daysToExpiry} days ago (Expires: ${m[1]}).`);
  console.error(`  Bump DEFAULT_EXPIRES in ${SOURCE} and update the policy review record.`);
  process.exit(1);
}

if (daysToExpiry < dayThreshold) {
  console.error(`✗ security.txt expires in ${daysToExpiry} days (threshold: ${dayThreshold}).`);
  console.error('  Refresh per spec/policies/14-vulnerability-management.md §5.3.');
  console.error(`  Bump DEFAULT_EXPIRES in ${SOURCE}.`);
  process.exit(1);
}

console.log(`✓ security.txt valid for ${daysToExpiry} more days (Expires: ${m[1]}).`);
process.exit(0);
