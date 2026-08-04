/**
 * The linter that had never run, plus the check that it is still running.
 *
 * ── WHAT WAS BROKEN ──────────────────────────────────────────────────────────
 *
 * `npm run lint` has been `eslint packages/*\/src/ tests/` since the initial commit, and
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
 *    stops matching after a directory move, a shell that fails to expand `packages/*\/src/`:
 *    every one of those is a silent, green, total loss of coverage, indistinguishable from
 *    success. {@link MIN_FILES} is the floor. If the linter examines fewer files than it did
 *    the day this was written, that is not a clean run, and this fails and says so.
 *
 * A lint script whose only consumer is a human typing it is the same shape of dead signal
 * as a lint script with no config, so `.github/workflows/lint.yml` runs this on every push
 * and `npm run lint` is this file rather than a bare `eslint` invocation.
 *
 * Run: node tools/lint-gate.mjs
 * Reproduce the raw output: npx eslint packages/*\/src/ tests/
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
 * shell expanding `packages/*\/src/` — cmd.exe does not, and a Windows run would otherwise
 * lint nothing and pass.
 *
 * ── ★ WHAT THIS SURFACE DOES NOT COVER, MEASURED ─────────────────────────────
 *
 * `tools/` is not on it, so THE GATES LINT EVERYTHING EXCEPT THEMSELVES. Measured with
 * `npx eslint tools`: 19 files, 7 errors, all pre-existing, and one of them is a question
 * this file is the wrong place to answer:
 *
 *   ★ `tools/derivation-lint.mjs` imports `readdirSync` and never calls it. Its
 *     `L2_L3_FILES` is a hand-maintained list of 15 names; `docs/ns/` holds 30 `.ttl`
 *     files. The unused import is the evidence that enumeration was the intent, and the
 *     gap is real: `a2a.ttl`, `hmd.ttl`, `vault-ld.ttl`, `wks.ttl`, `harness.ttl` and
 *     `alignment.ttl` are published L2/L3 ontologies that no derivation check has ever
 *     looked at. Whether they ground is UNKNOWN — enumerating could turn that gate red,
 *     which is a decision with its own audit, not a side effect of a lint sweep.
 *     `tools/ontology-lint.mjs`'s dead `EXTERNAL_PREFIXES` is the harmless kind by
 *     contrast (the scanner already restricts its regex to owned prefixes, so there is
 *     nothing for it to filter), and `tools/walkthrough-v6-distributed-values.ts` has one
 *     unused local.
 *
 * ★ `'tools'` IS NOW IN. It was "the right end state" here for a round while the ESLint
 * check NAME claimed "zero-error" over a scope chosen to exclude three live errors — a
 * different false claim in the same slot the round had just emptied of one. The three were
 * dead code and are deleted, not pinned: an unused `readdirSync` import in
 * derivation-lint.mjs, an unused `step()` in walkthrough-v6, and an `EXTERNAL_PREFIXES` set
 * in ontology-lint.mjs that only LOOKED like it excluded foreign vocabularies — that linter
 * iterates OWNED_NAMESPACES and never sees another prefix, so the exclusion is structural
 * and the list was a second, drift-prone statement of it.
 *
 * The gate now reads the directory its own tooling lives in, so a lint error in the code
 * that enforces lint can no longer merge.
 */
const TARGETS = ['packages', 'tests', 'tools'];

/**
 * The remaining debt: NONE. 0 errors in 0 files, down from 222 in 47.
 *
 * ★ AN EMPTY BASELINE IS THE STRONGEST STATE THIS FILE HAS, AND IT IS ALSO THE STRICTEST:
 * with nothing pinned, the "not on the baseline" branch below now fires on the FIRST lint
 * error anywhere under `packages/` or `tests/`. Do not add an entry back. If a rule is
 * genuinely wrong for this codebase, turn it off ONCE in eslint.config.js with a comment
 * saying why — a decision somebody can review — rather than pinning the count it produces,
 * which is a decision nobody ever revisits.
 *
 * The history below is kept because each round of it was the same lesson: the count is not
 * the finding. Every batch written off in this comment as "hygiene" or as "load-bearing at
 * a genuine dynamic boundary" contained at least one live defect, and the last batch — the
 * four `any`s at dynamic imports, the ones this file called "not statically resolvable even
 * in principle" — contained the worst one in the whole sequence.
 *
 * Nothing here was new code; every entry predated the config existing at all.
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
 * ── AND WHAT THE LAST 38 TURNED OUT TO BE ────────────────────────────────────
 *
 * The note here used to say the four dynamic-import `any`s could not be fixed because there
 * is "nothing to narrow TO", and that `registry.ts` needed a design decision rather than a
 * lint cleanup. Both were wrong, and the first was wrong in the expensive direction.
 *
 *   23  `packages/core/src/model/registry.ts`. The premise was right — `registerFacetType`
 *       is open, so a strategy branch can receive a facet shape it was not written for — and
 *       the conclusion did not follow: that is what `'validFrom' in f` SAYS, and unlike
 *       `any` it says it to the compiler. `('x' in f ? f.x : undefined)` and
 *       `('x' in f ? f.x ?? [] : [])` evaluate identically to the reads they replace,
 *       including for a foreign facet, so the merge arithmetic is untouched — the
 *       lexicographic `latestFrom > earliestUntil` the note singled out as semantics-
 *       sensitive needs no cast at all once the `&&` chain narrows both sides to `string`.
 *       `executeMerge` and `registerFacetType` appeared in NO test file, so
 *       `tests/facet-registry.test.ts` now covers them: 33 mutants of the arithmetic and
 *       the early-outs, each killed, including "filter the input to the type this branch
 *       expects" — the change the compiler most wants you to make, and the one that would
 *       have silently dropped a foreign facet out of every composition.
 *
 *   ★★ 1 `packages/extractors/src/index.ts` — AND THIS ONE WAS LIVE, AND TOTAL.
 *       `await import('pdf-parse') as any` was called "same story" as the optional native
 *       deps. It is not: `pdf-parse` is a DECLARED DEPENDENCY of that package, pinned at
 *       `^2.4.5`, with types of its own. There was nothing unresolvable to cast around; the
 *       `as any` was switching the compiler off. Underneath it, `extractPdf` called the v1
 *       API (`mod.default ?? mod`, then `pdfParse(buffer)`) against v2, which has no default
 *       export and whose namespace object is not callable. Measured against the installed
 *       module with a real one-page PDF: `extract()` returned the STRING
 *       `"[PDF extraction failed: pdfParse is not a function]"` with `format: 'pdf'`, a
 *       valid `contentHash`, and `metadata.extractor: 'pdf-parse'` — every PDF ever pushed
 *       through the extractor ingested that sentence instead of its contents, and nothing
 *       downstream could tell. `pdf` was also the ONLY branch of `extract()`'s switch with
 *       no test; the other five all had one. Both facts have the same single cause.
 *
 *    6  `packages/pgsl-store/src/fdb-real.ts` and
 *    1  `packages/pgsl-store/src/pg-store.ts`. Genuinely absent types, genuinely fixable:
 *       what the adapter needs is not the vendor's `.d.ts` but a statement of the calls it
 *       makes, and that can be written down. The `@ts-ignore` still covers the unresolvable
 *       specifier and now covers ONLY that. Verified both ways — a fake `foundationdb`
 *       installed with an incompatible shape still compiles (so the Linux integration job
 *       is unaffected), and renaming `getRangeAll` to the binding's other, iterator-returning
 *       `getRange` now fails tsc where it used to compile and throw in CI. `pg-store.ts`
 *       additionally had `new Pool(...)` on a possibly-undefined `pg.Pool ?? pg.default.Pool`.
 *
 *    1  `packages/core/src/crypto/wallet.ts` — `await import(moduleName)` where the
 *       specifier is a variable, so "not statically resolvable even in principle" is true
 *       of the IMPORT and says nothing about the three members read from it. Declared.
 *
 *    5  `tests/workspace-membership.test.ts` — four `no-regex-spaces` (`/\n  wsp:role …/`
 *       → `/\n {2}wsp:role …/`, exact) and one unused `type Attestation`, now annotating the
 *       one hand-written Attestation in the file: a `toEqual` expectation, which takes
 *       `unknown` and was therefore the only such literal not already checked.
 *    1  `tests/workspace-can.test.ts` — the `roster` computed and discarded. Fixed by
 *       deleting the `as unknown as` object literal it was displaced by and composing the
 *       view for real, which is what made the test falsifiable: `authorizeView` could have
 *       stopped populating `disallowed`, `notRead`, or `authorizedHere` and the old
 *       assertions would all still have passed.
 */
const BASELINE = {};

/**
 * The floor on how many files eslint must actually examine. 308 are linted today (304 the
 * day this was written); the allowance below it absorbs ordinary file deletion without
 * letting a coverage collapse through. Raised with the tree — a floor that drifts far below
 * reality stops being a floor, and at 280 it had 28 files of slack, enough to hide a whole
 * package's `src/` disappearing from the run.
 */
// Ratcheted 300 -> 320 when `tools` joined TARGETS (310 -> 329 files). A floor that stays
// far below the real count stops being a collapse detector: at 300 the gate would have
// shrugged off `tools` silently dropping back out.
const MIN_FILES = 320;

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
      // With BASELINE now empty this is the branch every error takes, so it has to say what
      // to do rather than name a list that no longer exists. "Add it to BASELINE" is exactly
      // the repair this gate exists to prevent.
      failures.push(
        `  ${file}: ${count} lint error(s).\n      ${samples.get(file)}\n`
        + '      Fix it. The baseline is EMPTY and stays empty — if the rule is wrong for\n'
        + '      this codebase, turn it off once in eslint.config.js with a comment saying\n'
        + '      why, which is reviewable. A pin and a per-line disable are not.',
      );
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
    // The zero case gets its own sentence: "0 known error(s) across 0 baselined file(s)" is
    // technically true and reads like a gate that checked nothing, which is the one thing
    // this file must never be mistaken for. The file COUNT is in both, because that is the
    // number that distinguishes a clean run from a collapsed one.
    const pinned = Object.keys(BASELINE).length;
    return pinned === 0
      ? `lint gate: ${result.files} file(s) linted, 0 errors, 0 baselined files — the `
        + 'baseline is empty, so any error anywhere now fails this gate.'
      : `lint gate: ${result.files} file(s) linted, ${result.total} known error(s) across `
        + `${pinned} baselined file(s), none anywhere else.`;
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
    // Derived from TARGETS, not retyped. These two lines said `packages tests` while the
    // gate read a third directory would be the same class of drift as the check name that
    // advertised a scope it did not have.
    `Reproduce: npx eslint ${TARGETS.join(' ')}`,
    `Autofixable subset: npx eslint --fix ${TARGETS.join(' ')}`,
    '',
  ].join('\n');
}

// Direct invocation — `node tools/lint-gate.mjs`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await runLintGate();
  console.log(lintGateReport(result));
  process.exit(result.ok ? 0 : 1);
}
