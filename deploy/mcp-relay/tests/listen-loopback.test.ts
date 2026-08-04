#!/usr/bin/env tsx
/**
 * A test server binds loopback, and cannot outlive the run that started it.
 *
 * ★ WHY THIS EXISTS. Eleven orphaned node processes were found still listening, the
 * oldest six days old — ten from this directory's tsx suites, one from css-gate. Two were
 * bound to `::`, which is EVERY INTERFACE, and that is what raised a Windows Defender
 * firewall prompt for a fixture that only ever talks to itself.
 *
 * Both halves were measured before anything was changed:
 *
 *   listen(0)              → { address: "::",       family: "IPv6" }
 *   listen(0, "127.0.0.1") → { address: "127.0.0.1", family: "IPv4" }
 *
 *   a script that listens, fetches once, and reaches its last line without closing:
 *       "end of script reached"   … and then EXIT CODE 124. It never exits. A listening
 *       handle by itself keeps the event loop alive, so the six-day survivors were not
 *       leaked sockets — they were processes that could not die because of one.
 *
 * So the two properties are asserted separately, because they fail separately: WHERE it
 * binds, and whether a skipped teardown can strand the process.
 *
 * ★ Mutation-checked, each applied and the suite re-run: dropping the '127.0.0.1' host
 * fails 3; dropping `unref()` fails 1; reverting a suite to a bare `app.listen(0)` fails
 * the source scan. And, for the widened walk: putting `app.listen(6099)` back into
 * `applications/_shared/vertical-bridge/affordance-manifest.test.ts` — a file the previous
 * version of this scan could not see at all — fails it, naming that path. And for the
 * MEASURED exemption: restoring the old hand count (`=== 6 && === 6`) fails, reporting
 * `5 files, 7 sites`; pointing `smokeDir` at a directory that does not exist fails at
 * `0 files, 0 sites` through ok() rather than an ENOENT stack, which is what proves the
 * number is read from the directory and not from a literal in this file.
 *
 * ★ TWO mutants SURVIVE, recorded rather than papered over:
 *
 *   - removing the `closed` short-circuit in `close()` changes nothing observable, because
 *     a second close is harmless anyway (Node hands the callback ERR_SERVER_NOT_RUNNING
 *     and the helper resolves). The assertion below is therefore written about the
 *     property callers depend on — calling close twice resolves twice — not about the line.
 *   - moving `closeAllConnections()` to AFTER `close()` still passes here, because modern
 *     Node's `close()` drops idle connections on its own and an idle keep-alive socket is
 *     all this file has. The ordering earns its place against an ACTIVE connection —
 *     mcp-transport-wiring's SSE stream — which `close()` waits for and this does not
 *     reproduce. Kept and labelled, not claimed as proven.
 *   - dropping `stripComments()` from the exemption count changes nothing: measured at 7
 *     both stripped and raw, because no comment in those five files happens to contain a
 *     `.listen(` token today. It is kept for the same reason the scan above keeps it — the
 *     next comment added there could flip the count — but it is not proven by this suite.
 *
 * Run from deploy/mcp-relay/:
 *   npx tsx tests/listen-loopback.test.ts
 */

import express from 'express';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { listenLoopback } from './listen-loopback.js';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  console.log('\na fixture that only talks to itself listens only to itself');

  // ── WHERE it binds ─────────────────────────────────────────────────────────
  //
  // The unguarded form is exercised too, rather than asserted about, so this file states
  // the defect it prevents instead of describing it. If a future Node made `listen(0)`
  // loopback by default, this assertion is the thing that would tell us.
  const bare = createServer(() => {});
  await new Promise<void>(r => bare.listen(0, () => r()));
  const bareAddr = bare.address() as AddressInfo;
  await new Promise<void>(r => { bare.close(() => r()); });
  ok(
    bareAddr.address === '::' || bareAddr.address === '0.0.0.0',
    '★ a bare listen(0) binds EVERY interface — the defect, reproduced not asserted',
    JSON.stringify(bareAddr),
  );

  const app = express();
  app.get('/', (_q, r) => { r.json({ ok: true }); });
  const srv = await listenLoopback(app);
  const addr = srv.server.address() as AddressInfo;
  ok(addr.address === '127.0.0.1', '★ listenLoopback binds 127.0.0.1 and nothing else', JSON.stringify(addr));
  ok(addr.family === 'IPv4', '…on IPv4, so there is no `::` alias to reach it by', JSON.stringify(addr));
  ok(srv.base === `http://127.0.0.1:${addr.port}`, 'and the base URL agrees with the socket', srv.base);

  // ── Whether a skipped teardown can strand the process ──────────────────────
  //
  // `unref()` is the property that turns the six-day survivor into a process that exits.
  // It is checked structurally because the behavioural check is "wait forever".
  ok(
    (srv.server as unknown as { _handle?: { hasRef?: () => boolean } })._handle?.hasRef?.() === false,
    '★ the listening handle is unref\'d — a forgotten close cannot hold the process open',
  );

  // ── close() completes with a keep-alive socket outstanding ─────────────────
  //
  // `fetch()` keeps its connection alive. `close()` alone stops accepting and then waits
  // for exactly that socket, which is why closeAllConnections() runs FIRST.
  const body = await fetch(`${srv.base}/`).then(r => r.json() as Promise<{ ok: boolean }>);
  ok(body.ok === true, 'the server actually serves over the loopback address');

  const closedInTime = await Promise.race([
    srv.close().then(() => true),
    new Promise<boolean>(r => { setTimeout(() => r(false), 5_000).unref(); }),
  ]);
  ok(closedInTime, '★ close() COMPLETES with an idle keep-alive socket outstanding');
  ok(srv.server.listening === false, '…and the socket is really down afterwards');

  // An `after` hook and a `finally` will both call this on a passing run. What callers
  // need is that the second call RESOLVES — neither rejecting nor hanging.
  const secondClose = await Promise.race([
    srv.close().then(() => 'resolved').catch((e: Error) => `rejected: ${e.message}`),
    new Promise<string>(r => { setTimeout(() => r('hung'), 5_000).unref(); }),
  ]);
  ok(secondClose === 'resolved',
    'close() called twice resolves both times — an `after` hook and a `finally` can both call it',
    secondClose);

  // ── No suite may go back to binding every interface ────────────────────────
  //
  // ★ The durable half — and the half that was first written ONE DIRECTORY WIDE.
  //
  // The original scan walked `deploy/mcp-relay/tests/` only, and called that "closing the
  // class". It was not: two suites in `applications/_shared/vertical-bridge/`, both run by
  // `.github/workflows/bridge-typecheck.yml`, were doing the WORSE version of the same
  // thing — `app.listen(6098)` / `app.listen(6099)`, measured as `{ address: "::" }` on a
  // FIXED port, so the LAN binding was live for the whole run and two runs could collide.
  // A guard that stops at its author's directory only proves the author's directory.
  //
  // So the walk is now the REPOSITORY, over test suites wherever they live.
  {
    /**
     * Comments are stripped before matching. The first draft did not strip them and
     * reported nine offenders, every one of which was the sentence explaining WHY the bad
     * form is bad — a check that fails on its own documentation is the kind that gets
     * deleted rather than obeyed.
     *
     * Block comments go first, then WHOLE-LINE `//` and jsdoc `*` continuations only:
     * stripping from a mid-line `//` would eat the `//` in every `http://127.0.0.1` and
     * could hide a real call, and a scan that can pass by accident is worse than none.
     */
    const stripComments = (src: string): string => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .filter(l => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');

    const repoRoot = join(here, '..', '..', '..');
    /**
     * ★ WHAT IS IN SCOPE, AND WHAT IS DELIBERATELY NOT — stated because a guard that
     * overstates its reach is the defect this round is about.
     *
     * IN: every `*.test.ts|mts|mjs` in the repository, plus every source file in this
     * directory (which holds fixtures that are not named `.test.` — `tck-sut.ts`,
     * `listen-loopback.ts` — and both already name their host).
     *
     * OUT, and named rather than silently missed:
     *
     *   - PRODUCTION entry points — every `server.ts` under `deploy/`, under an
     *     application's `bridge/`, and under `examples/`. Binding every interface is their
     *     JOB: they are reached from outside the box. This guard is about fixtures that
     *     only ever talk to themselves.
     *   - `applications/foxxi-content-intelligence/tools/*-smoke.ts` — FIVE files with
     *     SEVEN bare `app.listen(0)` sites, which therefore DO bind `::`. Those two numbers
     *     are DERIVED AND ASSERTED at the end of this block, not hand-counted here: the
     *     sentence they replace said "Six of them", which matched neither the file count nor
     *     the site count, because nothing in this file executed over the directory it was
     *     describing. They are dev tools, are run by no workflow, and their express half
     *     does not execute on this toolchain — each dies at `TypeError: pathRegexp is not a
     *     function` at its first route, before it ever reaches `listen`. The cause is not
     *     "a stale express": that package declares no express at all, and npm deduped
     *     express@4 flat to satisfy express-rate-limit next to a flat path-to-regexp@8,
     *     whose export is an object; express 4's `lib/router/layer.js` calls it as a
     *     function. Converting code that cannot be run is a change nobody can verify, so
     *     they are left — and left MEASURED below rather than described.
     */
    const skipDir = new Set([
      'node_modules', '.git', 'dist', 'build', 'coverage', 'scratchpad',
      '.vite', '.next', 'playwright-report', 'test-results', '.turbo',
    ]);
    const suites: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory()) {
          if (skipDir.has(ent.name)) continue;
          walk(join(dir, ent.name));
        } else if (
          /\.test\.(ts|mts|mjs)$/.test(ent.name)
          // Every suite in THIS directory, including the fixtures not named `.test.`
          // (tck-sut.ts, listen-loopback.ts).
          || dir === here
          // ★ And the loopback helpers themselves, wherever they live. There are three —
          // one per deployment unit — and they are the single point where the host argument
          // is supplied on behalf of every suite that uses them. A scan that checked only
          // the callers would pass forever while the one line they all depend on was
          // reverted. `deploy/css-gate/tests/loopback.mjs` and
          // `applications/_shared/vertical-bridge/listen-loopback.ts` are outside `here`.
          || /^(listen-)?loopback\.(ts|mts|mjs)$/.test(ent.name)
        ) {
          if (/\.(ts|mts|mjs)$/.test(ent.name)) suites.push(join(dir, ent.name));
        }
      }
    };
    walk(repoRoot);

    const offenders: string[] = [];
    for (const file of suites) {
      // This file is the one place the unguarded form is called ON PURPOSE, to reproduce
      // the `::` binding rather than assert a claim about it. Exempted by name so the
      // exemption is visible, rather than by a pattern that would quietly cover others.
      if (file.endsWith('listen-loopback.test.ts')) continue;
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const m of src.matchAll(/\.listen\(([^)]*)\)/g)) {
        // A host argument is the whole point. `listen-loopback.ts` and `tck-sut.ts` both
        // name it explicitly; anything else is binding the LAN by omission.
        if (!/['"]127\.0\.0\.1['"]/.test(m[1] ?? '')) {
          offenders.push(`${file.slice(repoRoot.length + 1)}: .listen(${m[1]})`);
        }
      }
    }
    // A scan that finds nothing because it LOOKED at nothing is the failure mode this
    // whole guard exists to prevent, so the population is asserted too. The two
    // vertical-bridge suites are outside this directory by construction: if the walk ever
    // stops reaching them, that is the one-directory regression, and it fails here.
    ok(suites.length > 50,
      '★ the walk actually reaches the repository, not just this directory',
      `${suites.length} suites scanned`);
    ok(
      suites.some(f => f.includes('vertical-bridge') && f.endsWith('mcp-wire-contract.test.ts'))
      && suites.some(f => f.includes('vertical-bridge') && f.endsWith('affordance-manifest.test.ts')),
      '★ …including the two CI-run suites the first version of this scan could not see',
    );
    ok(offenders.length === 0,
      '★ no test suite ANYWHERE in the repo calls .listen() without naming 127.0.0.1',
      offenders.join('; '));

    // ── The one named exemption is MEASURED, not described ─────────────────────
    //
    // ★ The scope note above used to read "Six of them call `app.listen(0)`". At HEAD it is
    // FIVE files and SEVEN call sites; six is neither, and had not been true for some time.
    // It could not fail loudly because NO assertion in this file executed over that
    // directory — the exemption existed only as prose, the files falling out of `suites`
    // passively by not matching any branch of the walk. A guard whose own scope note drifts
    // unwatched is committing, inside itself, the defect it exists to catch.
    //
    // So the exempted directory is now counted with the SAME strip-and-match machinery as
    // the scan above, and the note's numbers are asserted. A sixth tool, a new call site, or
    // one tool converted to `listenLoopback` each fails HERE — which is the point: the day
    // this hole is closed, or widened, the words describing it must change with the code.
    const smokeDir = join(repoRoot, 'applications', 'foxxi-content-intelligence', 'tools');
    // If that directory is ever moved or deleted this must FAIL BY NAME, not crash the run
    // with a readdir ENOENT stack: the note above would then be documenting a hole that no
    // longer exists, and it has to be deleted along with this check.
    const smokeFiles = existsSync(smokeDir)
      ? readdirSync(smokeDir).filter(n => n.endsWith('-smoke.ts')).sort()
      : [];
    let smokeUnguarded = 0;
    for (const name of smokeFiles) {
      const src = stripComments(readFileSync(join(smokeDir, name), 'utf8'));
      for (const m of src.matchAll(/\.listen\(([^)]*)\)/g)) {
        if (!/['"]127\.0\.0\.1['"]/.test(m[1] ?? '')) smokeUnguarded += 1;
      }
    }
    ok(smokeFiles.length === 5 && smokeUnguarded === 7,
      '★ the named exemption is exactly the 5 files / 7 unguarded sites the note claims',
      `${smokeFiles.length} files, ${smokeUnguarded} sites: ${smokeFiles.join(', ')}`);
  }

  if (fail > 0) {
    console.log(`\n${pass} passed, ${fail} failed`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\n${pass} passed, 0 failed\n`);
}

await main();
