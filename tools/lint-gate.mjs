/**
 * The linter that had never run, plus the check that it is still running.
 *
 * ── WHAT WAS BROKEN ──────────────────────────────────────────────────────────
 *
 * `npm run lint` has been `eslint packages/*​/src/ tests/` since the initial commit, and
 * the repo has never contained an eslint config in ANY format — no `.eslintrc*`, no
 * `eslint.config.*`, nothing in git history. `eslint@^9` treats a missing flat config as
 * a hard error, so for an unknown span of time the script's entire output was:
 *
 *   ESLint couldn't find an eslint.config.(js|mjs|cjs) file.
 *
 * exit code 2, zero files examined. No workflow in `.github/workflows/` ever called
 * `npm run lint`, so nothing reported the failure. The rules were reconstructed from the
 * `eslint-disable` directives left in the source — see the header of `eslint.config.js`.
 *
 * ── WHY A GATE AND NOT JUST THE eslint EXIT CODE ─────────────────────────────
 *
 * Two separate failure modes, and the raw exit code catches neither.
 *
 * 1. THE COUNT. Pointing the recovered config at 304 previously-unlinted files reports 222
 *    errors. Failing on all of them puts the script straight back to "always red, therefore
 *    ignored" — the state it was already in. Failing on none of them means the next one is
 *    invisible. So it RATCHETS per file, exactly as `tools/typecheck-gate.mjs` does: a file
 *    not on {@link BASELINE} may have no errors at all, a pinned file may not exceed its
 *    number, and a pinned file that IMPROVES also fails, naming the new number. A pin that
 *    only tightens when someone remembers is a pin that never tightens.
 *
 * 2. ★ THE FILE COUNT — the failure mode that produced this whole task. `eslint` exits 0
 *    when it lints nothing. A config whose `ignores` swallow the tree, a `files` glob that
 *    stops matching after a directory move, a shell that fails to expand `packages/*​/src/`:
 *    every one of those is a silent, green, total loss of coverage, indistinguishable from
 *    success. {@link MIN_FILES} is the floor. If the linter examines fewer files than it did
 *    the day this was written, that is not a clean run, and this fails and says so.
 *
 * A lint script whose only consumer is a human typing it is the same shape of dead signal
 * as a lint script with no config, so `.github/workflows/lint.yml` runs this on every push
 * and `npm run lint` is this file rather than a bare `eslint` invocation.
 *
 * Run: node tools/lint-gate.mjs
 * Reproduce the raw output: npx eslint packages/*​/src/ tests/
 *
 * ── NO SHEBANG ───────────────────────────────────────────────────────────────
 * Only because nothing needs one: this file is run as `node tools/lint-gate.mjs` and never
 * as an executable. It is NOT because a hashbang would break an importer. That reason was
 * asserted here and at the top of `tools/typecheck-gate.mjs`, and it was measured and found
 * false — vite's `ssrTransformScript` hoists around a leading `#!` and vite-node blanks it.
 * See that file's header for the measurement, so this does not get re-derived from scratch.
 */
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The lint surface, matching the `lint` script's historical targets. These are passed to
 * eslint as directories rather than shell globs so the gate does not depend on the calling
 * shell expanding `packages/*​/src/` — cmd.exe does not, and a Windows run would otherwise
 * lint nothing and pass.
 */
const TARGETS = ['packages', 'tests'];

/**
 * The remaining debt: 38 errors in 7 files, down from 222 in 47.
 *
 * Nothing here is new code; every entry predates the config existing at all.
 *
 * ── WHAT THE 67 THAT ARE GONE TURNED OUT TO BE ───────────────────────────────
 *
 * The note here used to write off all 49 `no-unused-vars` as "hygiene, not defects". That was
 * wrong about roughly a fifth of them, and the ones it was wrong about were the interesting
 * ones — an unused local in a TEST is very often an assertion that was dropped. All 49 sat in
 * `tests/**`; 47 are fixed (two live in `tests/workspace-*.test.ts`, which another change
 * owns). Of those 47:
 *
 *   ★  `tests/adversarial-audit.test.ts` built the attack artifact for "Attack 4: replay with
 *      a future timestamp" and for "Attack 5: claim pre-incident wallet compromise", then
 *      asserted nothing about either. Attack 4's only check compared two date literals. Both
 *      scenarios incremented `attacksRejected` and printed "✗ DETECTED" regardless.
 *   ★  `tests/multi-agent-integration.test.ts` computed `createAtomAffs` and never read it.
 *      Asserting it — see that file — showed the test's TITLE was false: the AAT decorator
 *      chain is additive, appending `denied` markers while leaving the actionable
 *      `POST create-atom` in place. The test now pins the real behaviour, both directions.
 *   ★  `tests/federation.test.ts`'s WebFinger mock discarded the URL it was called with, so
 *      the test named "should parse acct: URI domain" could not observe the parsed domain at
 *      all. It now asserts the `.well-known/webfinger` endpoint the resolver builds.
 *       — `tests/p2p-mirror.test.ts` constructed a `strangerClient` that published nowhere,
 *      left over from an approach two lines below replaced (deleted), and dropped a caught
 *      error that is now the thrown error's `cause`.
 *       — the rest were genuinely hygiene: 31 unused imports, three over-destructured
 *      `{ state: sA, op }` bindings, one dead `const`.
 *
 * The other 16 were `no-explicit-any`. `tests/interrogative-router.test.ts` reached into an
 * answer's `values` bag through `(a.values as any).x.y` fifteen times; a single `valueAt`
 * helper returning `unknown` replaces all of them and no longer suppresses the check that
 * `values` is present at all. Five more under `packages` were casts with nothing behind
 * them — including `factualStrategy(null as any, …)` against a parameter already declared
 * `PGSLInstance | null`, and a decorator whose `decorate(context: any)` is handed a
 * `DecoratorContext` by the same registry as every other decorator.
 *
 * ── ★ WHAT THE NEXT 117 TURNED OUT TO BE, AND THE CLAIM THAT WAS WRONG ───────
 *
 * The note here used to say the remaining `any`s "are load-bearing at genuine dynamic
 * boundaries and each needs a design decision rather than a substitution", and named
 * `affordance/compute.ts` + `engine.ts` (24 between them) as walking "heterogeneous facet
 * unions". That was false of both files and of most of the rest. 117 of the 155 are gone,
 * and the two named as hardest were the two easiest:
 *
 *   ★ 24  `compute.ts` + `engine.ts` were not walking anything heterogeneous. `FacetMap`
 *         ALREADY declares `trust?: TrustFacetData`, `semiotic?: SemioticFacetData` and so
 *         on, so ten `facets.trust as any` reads were casting an already-narrowed value to
 *         `any` and buying nothing but the loss of every property check underneath. The
 *         eleven in `engine.ts` were `facets.find(f => f.type === 'X') as any`, which a
 *         four-line `facetOf()` type-guard replaces outright.
 *
 *   ★★ AND THAT CAST WAS HIDING A LIVE DEFECT. With the narrowing on, tsc immediately
 *         reported `Property 'agentIdentity' does not exist on type 'AgentDescription'` at
 *         three sites. `agentIdentity` is the RDF PREDICATE (`iep:agentIdentity`, which
 *         `rdf/serializer.ts` emits FROM the field); the TypeScript property is `identity`.
 *         So `orient()`'s `if (agentFacet?.assertingAgent?.agentIdentity)` had never once
 *         been true — the OODA orientation's trustedSources map was never populated from an
 *         observation — and `evaluateSurprise`'s entire "unknown source?" factor (+0.3
 *         surprise, +0.4 epistemic value) was dead code. The same typo sat in
 *         `@interego/abac`'s `attribute-resolver.ts` behind a hand-written cast, where it
 *         made `resolveAttributes` clause (b) unreachable; see that file for why turning it
 *         back on is written down as widening rather than as a fix.
 *
 *     26  Doubles and fixtures built out of `any`: the fake Express in
 *         `engagement-durability.test.ts` (9), the two SCORM API surfaces in
 *         `rte-conformance.test.ts` (5) — in a CONFORMANCE test, of the very signatures
 *         under test — and `derivation.test.ts` (12), whose twelve casts were the
 *         `FacetTransformation<F extends ContextFacetData>` monoid being exercised with
 *         `number[]`. Twelve casts is an API saying the test is not testing it.
 *
 *     20  PGSL `Node` is a discriminated union on `kind` and `(node as any).value` appeared
 *         seventeen times in four test files immediately after a `kind === 'Atom'` check
 *         that had already narrowed it, plus `tools.ts` (3).
 *
 *     17  Readonly-mutation casts: `(registry as any).decorators` (4),
 *         `(broker as any).{conversations,memory,presence}` (6), `(pgsl.nodes as
 *         Map<IRI, any>)` (6), `(node as any).cid` (1). Each is a real and intended
 *         in-place write, so a cast stays — but to a `-readonly` mapped type that names the
 *         one liberty, not to `any`, which also erased the value being written.
 *
 *   ★  7  `connectors/src/index.ts`, and the last one there was also live. Narrowing
 *         `createConnector`'s three `as any` dispatches to each factory's own
 *         `Parameters<>` surfaced that `createSlackConnector` REQUIRES `channelId` and
 *         `createWebConnector` REQUIRES `urls`, which the factory's signature cannot
 *         promise: `createConnector({ type: 'slack', name: 'x' })` compiled and returned a
 *         connector polling `channels.history?channel=undefined` forever. Now refused at
 *         construction, with a test pinning both directions.
 *
 *     23  The rest, and 24 + 26 + 20 + 17 + 7 + 23 = 117: an LLM's `JSON.parse` output typed
 *         `as any[]` with none of its fields checked, `SearchOptions.facetType` as `string`
 *         where `DiscoverFilter` wants `ContextTypeName` (so `'trust'` silently matched
 *         nothing and looked like an empty result), `catch (err: any)` printing `undefined`
 *         for a non-Error throw, a token union read through `(t as any).value` where two of
 *         its members have no `value` at all, `CAPABILITY_REQUIREMENTS` typed `string[]`
 *         instead of `AgentCapability[]`, and the four `(a.values as any).x.y` in
 *         `projection-facets.test.ts` — replaced by the same `valueAt` helper
 *         `interrogative-router.test.ts` already uses, and for the same reason.
 *
 * ── WHAT IS LEFT, AND WHY, FILE BY FILE ──────────────────────────────────────
 *
 *   23  `packages/core/src/model/registry.ts` — the ONE file the old note described
 *       correctly. It is an open facet registry: `executeMerge` and `facetFingerprint`
 *       operate on third-party facet shapes by design, and every read is a bare
 *       `f.validFrom` / `f.causalConfidence` / `f.bindings` on a value with no declared
 *       type. `unknown` is the right type and it is not a substitution — each of ~12 reads
 *       needs its own narrowing, and two of them (`(f.causalConfidence ?? 0) > (best…)`,
 *       the string-sorted `validFrom` comparisons) change merge SEMANTICS if narrowed
 *       carelessly. That is a change to the composition operators with its own test
 *       surface, not a lint cleanup, and doing it inside one is how the wrong answer ships.
 *    6  `packages/pgsl-store/src/fdb-real.ts` — `await import('foundationdb')`, an optional
 *       native dependency installed only by `pgsl-store-fdb.yml`. No types are resolvable
 *       in a normal tree, so there is nothing to narrow TO; the same reason this file
 *       already has its own `ban-ts-comment` exception in eslint.config.js.
 *    1  `packages/pgsl-store/src/pg-store.ts` — `await import('pg')`, same story.
 *    1  `packages/extractors/src/index.ts` — `await import('pdf-parse')`, same story.
 *    1  `packages/core/src/crypto/wallet.ts` — `await import(moduleName)`, a runtime-named
 *       AgentKit module. Not statically resolvable even in principle.
 *    5  `tests/workspace-membership.test.ts` (four `no-regex-spaces`, one unused import) and
 *    1  `tests/workspace-can.test.ts` (one unused LOCAL) — another change owns both files.
 *
 * ★ "LOCAL", NOT "IMPORT", AND THE CORRECTION IS THE POINT OF THE PARAGRAPH ABOVE.
 * That paragraph is a long argument that an unused local in a TEST is very often an assertion
 * somebody dropped — and then this line mislabelled the one remaining instance of exactly that
 * shape as an import, which would have been harmless. `tests/workspace-can.test.ts:459` is
 * `const roster = rosterOf([...])`: computed, and discarded while the test builds a hand-rolled
 * `as unknown as` object instead. Measured, not restated: `npx eslint` reports it as
 * `'roster' is assigned a value but never used`.
 */
const BASELINE = {
  'packages/core/src/crypto/wallet.ts': 1,
  'packages/core/src/model/registry.ts': 23,
  'packages/extractors/src/index.ts': 1,
  'packages/pgsl-store/src/fdb-real.ts': 6,
  'packages/pgsl-store/src/pg-store.ts': 1,
  'tests/workspace-can.test.ts': 1,
  'tests/workspace-membership.test.ts': 5,
};

/**
 * The floor on how many files eslint must actually examine. 304 were linted the day this
 * was written; the allowance below it absorbs ordinary file deletion without letting a
 * coverage collapse through. Raise it when the tree grows — a floor that drifts far below
 * reality stops being a floor.
 */
const MIN_FILES = 280;

export async function runLintGate() {
  // The programmatic API rather than the CLI: `eslint`'s package `exports` does not expose
  // `bin/eslint.js`, and more importantly a config-resolution failure here THROWS instead of
  // becoming an exit code that a caller could mistake for a clean run.
  let report;
  try {
    const eslint = new ESLint({ cwd: ROOT, errorOnUnmatchedPattern: false });
    report = await eslint.lintFiles(TARGETS);
  } catch (err) {
    return {
      ok: false,
      fatal: `eslint could not run: ${err instanceof Error ? err.message : String(err)}`,
      files: 0, total: 0, failures: [],
    };
  }

  const counts = new Map();
  const samples = new Map();
  for (const f of report) {
    const file = relative(ROOT, f.filePath).split('\\').join('/');
    const errors = f.messages.filter(m => m.severity === 2);
    if (!errors.length) continue;
    counts.set(file, errors.length);
    const m = errors[0];
    samples.set(file, `${file}:${m.line}:${m.column}  ${m.message}  (${m.ruleId ?? 'core'})`);
  }

  const failures = [];

  // ★ Checked FIRST and separately from the error counts. Every count assertion below is
  // trivially satisfied by linting nothing, so "did it lint anything" cannot be inferred
  // from them — it has to be its own question.
  if (report.length < MIN_FILES) {
    failures.push(
      `  eslint examined only ${report.length} file(s); the floor is ${MIN_FILES}.\n`
      + '      Coverage collapsed — check eslint.config.js `ignores`, the TARGETS list in\n'
      + '      this file, and that the config still matches .ts. An eslint run that lints\n'
      + '      nothing exits 0, which is why this is asserted rather than assumed.',
    );
  }

  for (const [file, count] of [...counts].sort()) {
    const pinned = BASELINE[file];
    if (pinned === undefined) {
      failures.push(`  ${file}: ${count} lint error(s), and this file is not on the baseline.\n      ${samples.get(file)}`);
    } else if (count > pinned) {
      failures.push(`  ${file}: ${count} lint errors, pinned at ${pinned}. Existing debt may not grow.\n      ${samples.get(file)}`);
    }
  }
  for (const [file, pinned] of Object.entries(BASELINE).sort()) {
    const now = counts.get(file) ?? 0;
    if (now < pinned) {
      failures.push(
        `  ${file}: ${now} lint errors, pinned at ${pinned}. It IMPROVED — lower the pin in `
        + 'tools/lint-gate.mjs (or delete the line if it is 0) so the gain cannot be lost again.',
      );
    }
  }

  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return { ok: failures.length === 0, failures, files: report.length, total, fatal: null };
}

/** The message a human or a CI log sees. Kept out of the checker so callers can reuse it. */
export function lintGateReport(result) {
  if (result.ok) {
    return `lint gate: ${result.files} file(s) linted, ${result.total} known error(s) across `
      + `${Object.keys(BASELINE).length} baselined file(s), none anywhere else.`;
  }
  if (result.fatal) {
    return ['', '★ LINT GATE FAILED — eslint could not run', '', result.fatal, ''].join('\n');
  }
  return [
    '',
    '★ LINT GATE FAILED — eslint.config.js',
    '',
    ...result.failures,
    '',
    `(${result.files} file(s) linted; ${result.total} error(s) total.)`,
    'Reproduce: npx eslint packages tests',
    'Autofixable subset: npx eslint --fix packages tests',
    '',
  ].join('\n');
}

// Direct invocation — `node tools/lint-gate.mjs`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await runLintGate();
  console.log(lintGateReport(result));
  process.exit(result.ok ? 0 : 1);
}
