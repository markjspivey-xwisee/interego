#!/usr/bin/env tsx
/**
 * The E2E passkey suite still COLLECTS. Pre-merge gate, no network.
 *
 * ★ WHY THIS FILE EXISTS. `npx playwright test` in this directory used to exit 0
 * having run NOTHING. playwright.config.ts pointed testDir at ./tests without
 * setting testMatch, so Playwright's default glob swept in the `*.test.ts` tsx
 * programs that live here. Playwright imports every match to register test() calls;
 * importing one of these runs it to completion and it calls process.exit(0), which
 * kills Playwright's loader from the inside. Zero tests registered, no report, and
 * the shell saw exit 0. The live passkey workflow was green while the WebAuthn flow
 * it names was never exercised — it would have stayed green if the spec were
 * deleted.
 *
 * The live suite targets the deployed relay, so it cannot run on an arbitrary PR.
 * What CAN run on every PR is this: proof that the suite is still loadable and still
 * contains the test it claims to. That is the property whose loss went unnoticed.
 *
 * It drives the REAL Playwright collector in a child process rather than
 * re-deriving the glob. Re-deriving it would report "matches only *.spec.ts" and be
 * wrong — the failure is in the loader's reaction to process.exit, which only the
 * real collector can exhibit. `--list` loads config and files and launches no
 * browser, so this needs no browser binary and no `playwright install`.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = dirname(fileURLToPath(import.meta.url));
const relayDir = join(testsDir, '..');

// Recursion guard. If testMatch ever widens back so Playwright sweeps *.test.ts in,
// Playwright would IMPORT this very file during collection — and without the guard
// it would spawn another `playwright test --list`, which imports it again, without
// bound. The child carries this variable; the outer `npm test` run does not.
if (process.env['INTEREGO_PW_COLLECTION_PROBE'] === '1') {
  console.log('  (collection probe child — this file is inert here)');
} else {
  let failures = 0;
  const ok = (cond: boolean, name: string, detail = ''): void => {
    if (cond) { console.log(`  PASS  ${name}`); return; }
    failures++; console.error(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`);
  };

  console.log('\nThe E2E passkey suite still collects');

  const require_ = createRequire(import.meta.url);
  const r = spawnSync(
    process.execPath,
    [require_.resolve('@playwright/test/cli'), 'test', '--list', '--reporter=json'],
    { cwd: relayDir, encoding: 'utf8', env: { ...process.env, INTEREGO_PW_COLLECTION_PROBE: '1' } },
  );

  // A killed loader emits the unit scripts' prose on stdout instead of a report, so
  // "did JSON parse" IS the assertion that collection ran to completion.
  let parsed: { suites: { file: string; specs: { title: string }[] }[] } | null = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* loader died mid-import */ }
  ok(parsed !== null, 'the collector ran to completion and emitted parseable JSON',
     `stdout head: ${JSON.stringify(r.stdout.slice(0, 70))}`);

  const files: string[] = parsed ? parsed.suites.map(s => s.file).sort() : [];
  ok(JSON.stringify(files) === JSON.stringify(['passkey-oauth.spec.ts']),
     'exactly the passkey spec is collected', `collected: ${JSON.stringify(files)}`);

  const titles: string[] = parsed
    ? parsed.suites.flatMap(s => s.specs.map(x => x.title)) : [];
  ok(titles.some(t => /passkey OAuth dance/.test(t)),
     'the passkey OAuth test itself is registered', `titles: ${JSON.stringify(titles)}`);

  // Non-vacuity: assert the hazard is still present, so "nothing was swept in"
  // cannot pass merely because the tsx scripts moved away.
  const tsxScripts = readdirSync(testsDir).filter(f => f.endsWith('.test.ts'));
  ok(tsxScripts.length > 0, 'non-vacuity: tests/ really does hold self-exiting tsx scripts');
  ok(!files.some(f => tsxScripts.includes(f)),
     'none of those tsx scripts was swept into the Playwright run');

  console.log(failures === 0 ? '\nCollection gate holds.\n' : `\n${failures} failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}
