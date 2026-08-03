/**
 * The compiler that was missing from `npx vitest run tests/`.
 *
 * ── ON THE MISSING SHEBANG, AND ON THE STORY THIS BLOCK USED TO TELL ─────────
 *
 * This block asserted that the `#!/usr/bin/env node` the file shipped with (commit 34957ad)
 * was what made globalSetup throw a SyntaxError inside vite-node before collection, and that
 * the gate had therefore NEVER ONCE RUN under vitest. That is not true of this repo's
 * toolchain. It is corrected here rather than quietly deleted, because the claim was
 * specific enough to be checked and the next person will check it.
 *
 * Measured three ways against the locked versions — vitest 3.2.6, vite-node 3.2.4, vite
 * 7.3.5, and `package-lock.json` has not moved since that commit:
 *
 *   — this file with the hashbang put back, `npx vitest run tests/ipfs-cid.test.ts`: the
 *     gate loads and prints its line, exit 0;
 *   — `git show HEAD:tools/typecheck-gate.mjs` verbatim, hashbang and all, imported by a
 *     globalSetup: loads, and fails on its own RATCHET, not on a parse;
 *   — a two-line `.mjs` carrying a hashbang, imported from a test file and from a
 *     globalSetup: both fine.
 *
 * The toolchain handles it, in two places that are easy to find once looked for.
 * `vite/dist/node/chunks/config.js:15429` defines `hashbangRE`, and `ssrTransformScript`
 * takes its `fileStartIndex` from it so that every import and export it hoists is placed
 * AFTER the hashbang, leaving it at index 0. `vite-node/dist/client.mjs:373` then overwrites
 * a leading `#!` line with spaces before wrapping the module — guarded by
 * `transformed[0] === "#"`, which is precisely the position vite just preserved.
 *
 * The premise about Node was wrong independently: Node strips a hashbang from ANY ES module
 * it loads, not only from an entry file. `node -e` importing a hashbanged `.mjs` from another
 * `.mjs` works.
 *
 * Something real did throw once — `scratchpad/vitest.nogate.config.ts` was written around an
 * observed SyntaxError — but whatever it was is gone and it was not this. The hashbang stays
 * off because nothing invokes this file as an executable: `.github/workflows/
 * bridge-typecheck.yml` and every human run say `node tools/typecheck-gate.mjs`. It buys
 * nothing. It is no longer claimed to cost anything either.
 *
 * ── WHAT WAS NOT BEING TYPECHECKED, AND HOW IT WAS FOUND ─────────────────────
 *
 * vitest transpiles with esbuild. It strips types and runs the JavaScript underneath, so a
 * program that does not compile runs anyway. Everything else in this repo is covered by
 * something — `packages/*` by `npm run build`, `deploy/mcp-relay/*.ts` by relay-tests.yml,
 * every `applications/<v>/src` by that vertical's `bridge/tsconfig.json` include — but
 * `tests/**` was in no tsconfig at all, and `applications/shared-workspace` is the one
 * application with no `bridge/` directory and therefore no tsconfig reaching its source.
 *
 * Measured: deleting a required bail-out from `readAcceptanceRecord` left all 237 tests
 * GREEN, while `tsc` caught it outright. The suite could not see it because there was no
 * compiler in the loop.
 *
 * ── WHY A GATE SCRIPT AND NOT JUST `tsc -p` ──────────────────────────────────
 *
 * Turning the compiler on over a program nobody had ever compiled surfaced 58 pre-existing
 * errors in 18 files, none of them in this round's surface and several of them genuine
 * latent defects (`Object is possibly 'undefined'` in a test's own assertions; three tests
 * importing type names their package does not export). Fixing all of them here would be a
 * different change touching a dozen unrelated verticals, and gating on zero would mean the
 * gate goes in disabled — which is the outcome this file exists to avoid.
 *
 * So it RATCHETS, the same discipline `.github/workflows/a2a-conformance.yml` applies to the
 * A2A TCK:
 *
 *   — ANY error in a file not on {@link LEGACY} fails. New and changed code is fully gated.
 *   — An error count ABOVE a file's pinned number fails. Existing debt cannot grow.
 *   — An error count BELOW its pin fails too, naming the new number. A ratchet that only
 *     tightens when someone remembers to tighten it is a ratchet that never tightens.
 *
 * The pins are a debt register with a total, not a permission slip. Deleting a line from
 * LEGACY is how a file becomes permanently gated.
 *
 * Run: node tools/typecheck-gate.mjs
 * Also runs automatically in `vitest.config.ts`'s globalSetup, so `npx vitest run tests/`
 * cannot report green over source that does not compile, and as its own CI step in
 * bridge-typecheck.yml so it is not reachable only through a setup hook.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = join(ROOT, 'tsconfig.check.json');

/**
 * The remaining debt: 4 errors in 1 file, down from 97 in 28.
 *
 * Deleting a line from this list is how a file becomes permanently gated, and every deletion
 * was earned by a fix — never by an exclusion, and never by a cast that moved the error out of
 * tsc's sight without changing what the code does.
 *
 * ── WHAT THE 93 TURNED OUT TO BE ─────────────────────────────────────────────
 *
 * They arrived when `tsconfig.check.json` was made to include the globs it already CLAIMED to
 * include, so a third of the suite got a compiler for the first time. The previous note here
 * predicted most of them were "stricter-setting artifacts" in source each vertical's own bridge
 * tsconfig compiles more loosely. That was true of about half, and wrong about the rest —
 * recorded because the next person will want to know the base rate.
 *
 *   29  ONE wrong `Wallet`. `applications/_shared/tests/aggregate-privacy.test.ts` bound the
 *       bare name `Wallet` to the ethers CLASS, while every signing entry point it calls takes
 *       `@interego/core`'s `Wallet` record. 15 `as unknown as Wallet` casts (5 more in
 *       `compliance-overlay/tests/aggregate-bridge.test.ts`) forced core wallets across, which
 *       did not convert anything — it only stopped the arguments being checked at all.
 *
 *   27  `noUncheckedIndexedAccess` in `foxxi-content-intelligence/src`, almost all of it regex
 *       group-1 reads behind an `if (m)` that does not narrow the group. Genuine artifacts of a
 *       setting that vertical's bridge tsconfig does not turn on — fixed by narrowing on the
 *       group (`if (m?.[1])`) rather than asserting, because an assertion here would have to be
 *       re-audited every time the pattern changes.
 *
 *   ★ 6 A REAL DEFECT, and the reason this gate is worth its cost.
 *       `AgentActionEvent.agentDid` is required; all six wrappers in
 *       `compliance-overlay/src/aggregate-bridge.ts` omitted it. `buildAgentActionDescriptor`
 *       interpolates it unguarded, so every compliance descriptor the bridge produced ended
 *       `prov:wasAttributedTo <undefined> ; prov:wasAssociatedWith <undefined> .` — an audit
 *       record whose whole purpose is naming who ran an aggregate query, naming nobody.
 *       Reproduced by running the builder before fixing it.
 *
 *   3   Two more wrong-import-path finds of the same shape as the `Wallet` one:
 *       `SensitivityFlag` reached for off `@interego/core` (it is `@interego/privacy`'s) in
 *       `compliance-overlay/src/overlay.ts`, twice — so the sensitivity flags that module hands
 *       back were an error type — plus a `{ shareWith }` option passed to `publish()`, which
 *       has no such property and silently dropped it. That last one was ALREADY found and
 *       fixed in `openclaw-memory/src/bridge.ts`, whose comment says so, and left standing
 *       here; the claim is now deleted rather than repaired, since `publish()` cannot honour it.
 *
 *   2   Tests that asserted nothing. `regime-read-is-not-species-gated.test.ts` read
 *       `d.plan?.interventions ?? []` off a `Diagnosis` that has no `plan` — always `[]`, so
 *       the one assertion checking WHERE Emergent work routes could not fail. And
 *       `mcp-server/tests/stdio-serves-both-eras.test.ts` passed `versionNegotiation` to
 *       `connect()` instead of the `Client` constructor, so both iterations of its "both eras"
 *       loop ran the identical legacy handshake and the probe-and-fallback path the file was
 *       written for was never taken.
 *
 *   26  The rest: indexed access under assertions that would pass vacuously on an empty
 *       result (now length-checked first), `createPGSL()` called with none of its one required
 *       argument in 8 places, a `wasAttributedTo: [did]` where the facet takes a single IRI
 *       (read back through an array cast, so `.toContain` passed on the substring), a dead
 *       `tamperedZip` nobody used, and two ambient `.d.ts` files that exist in the tree and
 *       were simply not in this program.
 *
 * ── WHY THESE FOUR ARE STILL HERE ────────────────────────────────────────────
 *
 * All four are `tests/abac.test.ts`, and all four are the same finding: THE REPO HAS TWO
 * INCOMPATIBLE TRUST VOCABULARIES AND THE TYPE ENCODES THE ONE NOTHING USES.
 *
 *   packages/core/src/model/types.ts   TrustLevel = 'SelfAsserted' | 'ThirdPartyAttested'
 *                                                 | 'CryptographicallyVerified'
 *   packages/registry/src/index.ts     issuerTrustLevel?: 'HighAssurance' | 'PeerAttested'
 *                                                       | 'SelfAsserted'
 *   docs/AGENT-PLAYBOOK.md L117        "HighAssurance > PeerAttested > SelfAsserted"
 *   deploy/mcp-relay/server.ts L8141   advertises "Forces trust to HighAssurance"
 *
 * Only `SelfAsserted` is common to both. `TrustFacetData.trustLevel` is typed with core's
 * union, but the vocabulary the relay advertises, the docs document, the registry weights,
 * and this test exercises is the other one — so `trustLevel: 'HighAssurance'` cannot be
 * written without a cast, and the two `as IRI` casts at L64/L69 are what was hiding it.
 * A fourth-of-the-same: L232 constructs `amtaAxes` on a Trust facet, which
 * `packages/abac/src/attribute-resolver.ts:129` reads back out through its own inline
 * `(f as { amtaAxes?: ... })` cast because `TrustFacetData` never declared the field.
 *
 * Making the test compile means either changing it to stop exercising the vocabulary the
 * system actually ships, or changing a core substrate type. Both are decisions about which
 * vocabulary is canonical, not cleanups, so the errors stay pinned and VISIBLE rather than
 * being cast away. Pinning is the honest state here; a cast would delete the question.
 */
const LEGACY = {
  'tests/abac.test.ts': 4,
};

/** `path/to/file.ts(12,3): error TS1234: …` — the only line shape tsc reports errors on. */
const ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error TS\d+:/;

export function runTypecheckGate() {
  const tsc = require.resolve('typescript/lib/tsc.js');
  const run = spawnSync(process.execPath, [tsc, '--noEmit', '-p', PROJECT], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;

  const counts = new Map();
  const samples = new Map();
  for (const line of output.split(/\r?\n/)) {
    const m = ERROR_LINE.exec(line);
    if (!m) continue;
    // tsc prints paths relative to the project when invoked with -p, but normalise anyway so
    // a Windows separator or an absolute path cannot slip a file past its pin.
    const file = relative(ROOT, join(ROOT, m[1])).split('\\').join('/');
    counts.set(file, (counts.get(file) ?? 0) + 1);
    if (!samples.has(file)) samples.set(file, line.trim());
  }

  const failures = [];
  for (const [file, count] of [...counts].sort()) {
    const pinned = LEGACY[file];
    if (pinned === undefined) {
      failures.push(
        `  ${file}: ${count} type error(s), and this file is not on the legacy list.\n`
        + `      ${samples.get(file)}`,
      );
    } else if (count > pinned) {
      failures.push(`  ${file}: ${count} type errors, pinned at ${pinned}. Existing debt may not grow.\n      ${samples.get(file)}`);
    }
  }
  for (const [file, pinned] of Object.entries(LEGACY).sort()) {
    const now = counts.get(file) ?? 0;
    if (now < pinned) {
      failures.push(
        `  ${file}: ${now} type errors, pinned at ${pinned}. It IMPROVED — lower the pin in `
        + 'tools/typecheck-gate.mjs (or delete the line if it is 0) so the gain cannot be lost again.',
      );
    }
  }

  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const pinnedTotal = Object.values(LEGACY).reduce((a, b) => a + b, 0);
  return { ok: failures.length === 0, failures, total, pinnedTotal, output };
}

/** The message a human or a CI log sees. Kept out of the checker so vitest can reuse it. */
export function typecheckGateReport(result) {
  if (result.ok) {
    return `typecheck gate: ${result.total} known error(s) across ${Object.keys(LEGACY).length} `
      + 'legacy file(s), none anywhere else.';
  }
  return [
    '',
    '★ TYPECHECK GATE FAILED — tsconfig.check.json',
    '',
    'vitest does not typecheck. This gate is the compiler for every file vitest executes',
    '(see tsconfig.check.json), and it just found something the suite cannot see:',
    '',
    ...result.failures,
    '',
    `(${result.total} total; ${result.pinnedTotal} are pinned pre-existing debt.)`,
    'Reproduce: npx tsc --noEmit -p tsconfig.check.json',
    '',
  ].join('\n');
}

// Direct invocation — `node tools/typecheck-gate.mjs`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = runTypecheckGate();
  console.log(typecheckGateReport(result));
  process.exit(result.ok ? 0 : 1);
}
