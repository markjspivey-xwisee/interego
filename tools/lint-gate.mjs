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
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
 * ── ★ THE EXPANSION, AS A CEILING RATHER THAN AS 185 PER-FILE PINS. ──────────────────────
 *
 * `deploy/` and `applications/` are the two source roots the zero-error surface above does
 * NOT cover. Expanding TARGETS to include them was written down as an item and then declined,
 * for a reason that was correct as far as it went: the debt is 1,762 errors across 185 files
 * — measured, `npx eslint deploy applications` — so a per-file EXPANSION_BASELINE would pin
 * ~185 exact numbers over a tree several agents edit concurrently, and any of them tidying
 * one `console.log` reds master on a file they did not break.
 *
 * ★ BUT "TOO BRITTLE TO PIN PER FILE" IS NOT "LEAVE IT UNMEASURED", AND THAT IS WHAT IT
 * BECAME. Nothing looked at either root. The debt could double, a whole directory could
 * arrive un-linted, and every gate in this repo would stay green — which is the same shape as
 * the two defects at the top of this file (a linter with no config, a linter with no
 * workflow): a signal wired to nothing.
 *
 * So the roots ARE linted on every run, and what is pinned is one number per root instead of
 * one per file:
 *
 *   - the count MAY NOT GROW. New lint debt in `deploy/` or `applications/` fails here.
 *   - if it FALLS by more than {@link FRONTIER_TOLERANCE}, that fails too, naming the number
 *     to write — the same both-ways ratchet the per-file baseline had, and for the same
 *     reason: a pin that only tightens when somebody remembers is a pin that never tightens.
 *   - the file count per root is a floor, because eslint exits 0 when it lints nothing and a
 *     root that stops being scanned reports zero errors, which is indistinguishable from a
 *     root that was cleaned.
 *
 * The tolerance is what makes this survivable where a per-file baseline was not: one number
 * absorbs the ordinary churn of a shared tree, and only a real change of scale moves it. It
 * is set wide deliberately — `deploy/mcp-relay/server.ts` alone carries 24 of the 382 and is
 * under active edit as this is written, so a pin with no slack would red on a change nobody
 * made a mistake in.
 *
 * This is NOT the end state. The end state is these roots joining TARGETS with the same empty
 * baseline as `packages/`, and that means triaging 1,762 errors — of which 1,143 are
 * `no-console` in bridge and CLI code, which is a config question (does the rule apply to a
 * server's own stdout?) rather than a debt question, and should be answered once in
 * eslint.config.js the way every other scoped exception here was. What this refuses is the
 * gap staying INVISIBLE while that decision waits.
 */
/**
 * ★★ AND THE CENSUS BELOW FOUND FIVE MORE THAT THE ITEM NEVER NAMED. The expansion item said
 * "deploy/ + applications/". Asking the tree instead of the item added `benchmarks/` (193
 * errors), `spec/` (48 in ONE file), `demos/` (48), `mcp-server/` (33 — and that one is a
 * declared npm WORKSPACE, not a scratch directory) and `scripts/` (7). 1,994 errors across
 * 509 files, in seven roots, observed by nothing. That is the argument for the census being a
 * check rather than a list: the list was written by someone who knew about two of them.
 */
const UNLINTED_FRONTIER = {
  // All measured 2026-08-04 by `lintTrackedUnder` — i.e. over `git ls-files`, so these are
  // properties of the COMMIT and reproduce byte-for-byte in CI. The first numbers written
  // here were taken from `npx eslint <root>`, which walks the disk, and every one of them
  // was wrong: gitignored files inflated `benchmarks` by 414 errors alone. See
  // `lintTrackedUnder` for the measurement.
  //
  // deploy: dominated by `no-explicit-any` and `no-console`, plus `no-undef` in `.mjs` —
  // where eslint is the only compiler there is.
  //
  // ★ NOTE FOR WHOEVER SEES THIS ROOT GO RED FIRST. `deploy/mcp-relay/server.ts` alone
  // carries 24 of the 356 and was under active edit when this number was taken. If that work
  // lands and the count moves past the tolerance, the failure is the ratchet working, not a
  // false alarm: write the new number in and move on.
  deploy: { errors: 356, files: 106 },
  // The bulk of these are `no-console` in vertical bridges and CLI entry points — one config
  // decision, not a thousand defects. See the note above.
  // ★ 320 -> 337, and the ratchet caught it in CI rather than locally, which is the interesting
  // part. The local run that passed was taken BEFORE the last of five new
  // `applications/shared-workspace/tools/*.ts` live drivers landed, so it measured 332 and sat
  // inside the slack; CI measured the commit and got 337. A gate that reads `git ls-files`
  // measures what was COMMITTED, and the only run that can be trusted is one taken after the
  // last edit. The error count is unchanged at 1309: these five are `no-console` CLI drivers,
  // and `lintTrackedUnder` counts errors, not files, for that number.
  applications: { errors: 1309, files: 337 },
  benchmarks: { errors: 193, files: 31 },
  demos: { errors: 48, files: 37 },
  // A declared npm workspace (see package.json `workspaces`), never linted.
  'mcp-server': { errors: 33, files: 4 },
  scripts: { errors: 7, files: 10 },
  // 48 errors in a single file. The spec directory is mostly Markdown and Turtle; the one
  // JavaScript file in it has never been examined by anything.
  spec: { errors: 48, files: 1 },
};

/**
 * How far a frontier count may move before this fails.
 *
 * Proportional with a floor, because these roots span two orders of magnitude and one
 * absolute number cannot serve both: 30 is tight on `applications/` (1,380) and larger than
 * the whole of `scripts/` (7), which would make that root's ceiling meaningless. 5% absorbs
 * the ordinary churn of a shared tree in proportion to the root's size; the floor of 5 stops
 * a small root from having a tolerance of zero, which would red on a one-line change.
 *
 * Exported so the self-test derives its fixtures from it instead of restating the numbers —
 * the mistake `tests/vitest-run-integrity.test.ts` had to be rescued from.
 */
export const frontierTolerance = pin => Math.max(5, Math.ceil(pin * 0.05));

/**
 * Top-level directories that hold no lintable source, or whose source eslint.config.js
 * deliberately ignores. Anything NOT here, not in TARGETS and not in UNLINTED_FRONTIER fails
 * the census below — because the failure mode this whole file exists for is coverage that is
 * absent rather than coverage that is red, and a NEW top-level source root is the largest
 * version of that. `examples/`, `integrations/` and `interego-main/` are not listed: they are
 * in eslint.config.js's `ignores`, so the census finds no lintable file in them and they need
 * no entry here. Two statements of one exclusion is the drift this repo keeps deleting.
 */
const CENSUS_EXEMPT = new Set([
  'node_modules', 'dist', 'build', 'coverage', 'scratchpad', '.git', '.github', '.claude',
  '.interego', '.vscode', '.husky',
]);

/** Extensions eslint.config.js's rules apply to. */
const LINTABLE = /\.(?:[cm]?ts|[cm]?js)$/;

/**
 * Lint what the REPOSITORY holds under `root`, not what this disk holds.
 *
 * ★ WHY NOT `eslint.lintFiles([root])`. That walks the directory, and flat-config eslint
 * does not read `.gitignore` — so every gitignored file present locally joins the census.
 * The frontier pins are then a measurement of one machine's working directory, and the
 * gate reds for a reason the contributor cannot see in the diff.
 *
 * Measured, this PR: `benchmarks/` counted 37 files here and 31 in CI. The six are
 * `benchmarks/locomo/static/js/{bulma-carousel,bulma-slider,fontawesome.all,index}*.js`
 * — vendored assets, gitignored, on disk only. `deploy/` differed the same way, 382
 * errors against CI's 356, and the gate correctly refused BOTH directions.
 *
 * `git ls-files` makes the number a property of the commit, so it is identical on every
 * machine and in CI, and a file must be committed before it can move a pin. eslint's own
 * `ignores` still apply on top, via `isPathIgnored` — the two filters compose rather than
 * one standing in for the other.
 */
async function lintTrackedUnder(eslint, root) {
  // No `cwd` guard needed: ROOT is this file's parent, which is the repo root by
  // construction. A git failure THROWS, and the caller fails closed on it — "could not
  // scan" must never read the same as "scanned and unchanged".
  const listed = execFileSync('git', ['ls-files', '-z', '--', root], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const tracked = listed.split('\0').filter(f => f && LINTABLE.test(f));
  const scannable = [];
  for (const f of tracked) if (!await eslint.isPathIgnored(f)) scannable.push(f);
  // `lintFiles([])` throws in eslint 9; an empty root is a legitimate state that the
  // file-count floor in `frontierFailures` is what judges.
  return scannable.length ? await eslint.lintFiles(scannable) : [];
}

/** Directory names never worth descending into when looking for a lintable file. */
const NEVER_DESCEND = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

/**
 * Does this directory contain at least one file eslint would lint? Stops at the first hit —
 * this is a presence question, not a count, and walking `applications/` to exhaustion to
 * answer "is there any TypeScript here" would make the gate pay for the answer twice.
 *
 * `isPathIgnored` is asked because a root can be full of `.ts` that eslint.config.js ignores
 * (`examples/`, `integrations/`), and a census that demanded an entry for those would be
 * asking for the ignore list to be written down a second time.
 */
async function hasLintableSource(eslint, dir, depth = 0) {
  if (depth > 6) return false;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (NEVER_DESCEND.has(e.name)) continue;
      if (await hasLintableSource(eslint, full, depth + 1)) return true;
    } else if (LINTABLE.test(e.name) && !e.name.endsWith('.d.ts')) {
      if (!await eslint.isPathIgnored(full)) return true;
    }
  }
  return false;
}

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
//
// ★ 320 -> 344, AND THIS ONE WAS NOT NOTICED BY A HUMAN — it was found by adding the drift
// check below. The tree had walked to 354 while the floor sat at 320, i.e. 34 files of slack:
// MORE THAN THE WHOLE OF `tools/` (19 files). The exact scenario the comment above says the
// floor exists to prevent had quietly become possible again, by nothing but the tree growing.
// A floor corrected only when somebody remembers is a floor that is always stale.
// 344 -> 346 in the same round, fired again by the drift check the moment this round's own
// two test files and one gate script landed (354 -> 356). That is the ratchet behaving: it
// caught its author, not just history.
// 352 -> 353, fired by the drift check again, this time on the round that added the
// shared-workspace agent runtime and tools/railway-registry-credentials.mjs (352 -> 363).
// Caught its author for the second consecutive time, which is the whole argument for a
// floor that fails when it is TOO LOW as well as when it is breached.
// 365 -> 370, fired for the third consecutive time, on the round that moved the workspace
// client's membership, documents and canvas logic out of the published artifact's
// hand-written script into `packages/workspace-client/src` and added the desktop shell's
// renderer test and five live drivers (365 -> 380). The gate named the number.
// 370 -> 371, fired for the FOURTH consecutive time, on the round that added
// `tools/probe-notification-scope-live.ts` — the live driver that reproduced the
// cross-pod notification disclosure (380 -> 381). One file was all the remaining slack.
// 371 -> 373, fired for the FIFTH consecutive time, on the round that added the Discord bot:
// `packages/workspace-client/src/delegation.ts` (acting for another pod under a delegation that
// pod's owner published) and `tests/workspace-client-delegation.test.ts` (381 -> 383). The bot
// itself lives under `applications/`, which is frontier rather than a zero-error target, so only
// the two files that landed in the linted tree move this number.
// 373 -> 374, on the round that added `tools/probe-sse-mcp-handshake-live.ts` — the live driver
// that measured `GET /sse` failing an MCP handshake against the protocol's own
// SSEClientTransport (383 -> 384). Not forced by the floor this time (384 - 373 is 11, one past
// the allowance, so it WAS forced — but only after the Discord round landed first; measured
// against master alone it was 382 and inside it). Moved regardless: a ratchet that advances
// only when the gate shouts spends its life one file from useless. The round's other two new
// files live under `applications/`, which is frontier rather than a zero-error target, so they
// do not move this number.
export const MIN_FILES = 376;

/**
 * How far below the real linted-file count MIN_FILES may sit before that is itself a failure.
 * Same mechanism, same reasoning and the same number as `tools/vitest-run-integrity.mjs`'s
 * FLOOR_ALLOWANCE: enough to absorb ordinary file deletion, not enough to hide a directory.
 *
 * Exported with MIN_FILES so `tests/lint-gate.test.ts` derives its fixtures from them rather
 * than restating the numbers — two sources of truth for one number is what the gate exists
 * to prevent, and a self-test is not exempt from it.
 */
export const FILE_FLOOR_ALLOWANCE = 10;

/**
 * The workflow whose job NAME is this gate's public label — the one line about it that a
 * reviewer sees on a PR status without opening a log. Checked here, by the job that file
 * names, because this is the only place the label and the real pin count are both in hand.
 */
const WORKFLOW = join(ROOT, '.github', 'workflows', 'lint.yml');

/**
 * A numeric "<n> files pinned" / "<n> baselined files" claim, either word order, because
 * the drift is in prose and prose does not keep one shape. Read only via `matchAll`, which
 * clones the regex — a module-level /g regex passed to `.test()` carries `lastIndex`
 * between calls and would skip every other claim.
 */
const PIN_CLAIM = /(\d+)\s+(?:files?\s+(?:pinned|baselined)|(?:pinned|baselined)\s+files?)/gi;

/** The non-numeric way the label can state the same fact. */
const EMPTY_CLAIM = /empty baseline|baseline is empty|no baselined files/i;

/**
 * ★ THE FAILURE THIS PREVENTS. This job's name read
 * "Flat-config lint + ratcheted baseline (47 files pinned)" and GitHub published it on
 * every run — "(47 files pinned) -> success" — while the same job's log printed
 * "0 errors, 0 baselined files". 47 was the count the day BASELINE was written; emptying it
 * changed the code and not the label, and nothing read the label, so nothing could notice.
 * The stale number UNDERSTATED a gate that is at its strictest when nothing is pinned.
 *
 * The repair that followed deleted the number rather than correcting it. That is better
 * prose and still unchecked, so this accepts EITHER form and checks whichever is present:
 * a numeric claim must equal the real pin count, and a "empty baseline" claim must be true.
 * What is refused is a label that states neither — because a label with no claim in it is
 * one nothing can ever contradict, which is how the 47 survived.
 *
 * Text in, so a test can hand it a stale label; `pinned` defaults to the real BASELINE so
 * the live call and the test call are the same function, not a copy of it.
 *
 * @param {string} workflowText  contents of .github/workflows/lint.yml
 * @param {number} [pinned]      files on the baseline; defaults to the real one
 * @returns {string|null}        a failure paragraph, or null
 */
export function baselineClaimFailure(workflowText, pinned = Object.keys(BASELINE).length) {
  // ★ THE `name:` LINES ONLY, NOT THE WHOLE FILE. Scanning the file text matched the
  // comment in lint.yml that RECORDS the old "47 files pinned" as history, and failed the
  // gate on an accurate sentence about a fixed defect. The label GitHub publishes is the
  // job name; that is the claim, and it is the only part that must be true in the present
  // tense. Measured: the whole-file scan reports `claims "47 files pinned"` against a job
  // named "(zero-error, empty baseline)".
  const names = [...workflowText.matchAll(/^\s*name:\s*(.+)$/gm)].map(m => m[1]).join('\n');
  if (names.trim() === '') {
    return '  .github/workflows/lint.yml has no `name:` line at all — this guard is reading\n'
      + '      the wrong file, or the workflow lost its job name.';
  }
  const claims = [...names.matchAll(PIN_CLAIM)];
  if (claims.length > 0) {
    const wrong = claims.filter(m => Number(m[1]) !== pinned);
    if (wrong.length === 0) return null;
    return `  .github/workflows/lint.yml claims ${wrong.map(m => `"${m[0]}"`).join(', ')}, but `
      + `BASELINE pins ${pinned} file(s).\n`
      + '      Update the job name in that workflow. It is the label on every PR status for\n'
      + '      this gate, and a stale count there understated the gate for every run after\n'
      + '      the debt hit zero.';
  }
  if (EMPTY_CLAIM.test(names)) {
    if (pinned === 0) return null;
    return `  .github/workflows/lint.yml calls the baseline EMPTY, but BASELINE pins `
      + `${pinned} file(s).\n`
      + '      The label is the only description of this gate a reviewer sees without\n'
      + '      opening the log, and it is now claiming a stricter gate than the one running.';
  }
  return '  .github/workflows/lint.yml states nothing about the baseline.\n'
    + `      Its job name must either say "${pinned} files pinned" or say the baseline is\n`
    + '      empty. Deleting the claim rather than correcting it is what puts the label\n'
    + '      back out of reach of every check — which is how "(47 files pinned)" survived\n'
    + '      long after the debt reached zero.';
}

/**
 * The frontier failures for one root, given what eslint measured and what is pinned.
 *
 * Numbers in, so `tests/lint-gate.test.ts` can drive every direction without running eslint
 * over 474 files; the live call passes the real measurements, so the tested function and the
 * running function are the same one.
 *
 * @param {string} root      'deploy' | 'applications'
 * @param {{errors:number,files:number}} pin  the entry in UNLINTED_FRONTIER
 * @param {{errors:number,files:number}} now  what this run measured
 * @returns {string[]} failure paragraphs
 */
export function frontierFailures(root, pin, now) {
  const out = [];
  const fileSlack = frontierTolerance(pin.files);
  const errSlack = frontierTolerance(pin.errors);
  // ★ FILES FIRST, and separately, exactly as MIN_FILES is above: every error assertion below
  // is satisfied by scanning nothing, so a root that stopped being scanned reports 0 errors
  // and reads as a root that was cleaned.
  const collapsed = now.files < pin.files - fileSlack;
  if (collapsed) {
    out.push(
      `  ${root}/: eslint examined ${now.files} file(s); ${pin.files} were pinned.\n`
      + '      That is not a smaller root, that is a root falling out of the scan — and a\n'
      + '      scan of nothing reports zero errors, which passes every count check below.\n'
      + `      If the shrink is real, write { errors: ${now.errors}, files: ${now.files} } into\n`
      + '      UNLINTED_FRONTIER in tools/lint-gate.mjs.',
    );
  } else if (now.files > pin.files + fileSlack) {
    out.push(
      `  ${root}/: eslint examined ${now.files} file(s), pinned at ${pin.files}. The root grew\n`
      + `      past the ${fileSlack} of slack. Write files: ${now.files} into UNLINTED_FRONTIER\n`
      + '      in tools/lint-gate.mjs so the floor keeps meaning something.',
    );
  }
  if (now.errors > pin.errors + errSlack) {
    out.push(
      `  ${root}/: ${now.errors} lint error(s), pinned at ${pin.errors}. Existing debt on the\n`
      + '      un-linted frontier may not grow. Fix what you added — do not raise the pin.\n'
      + `      Reproduce: npx eslint ${root}`,
    );
  } else if (now.errors < pin.errors - errSlack && !collapsed) {
    // ★ `&& !collapsed`, AND THIS WAS A REAL DEFECT CAUGHT BY THE CASE BELOW IT IN
    // tests/lint-gate-ci-claim.test.ts, not by reading. A root that falls out of the scan
    // reports 0 files AND 0 errors, so without this it produced BOTH failures at once: the
    // honest one ("that is a root falling out of the scan") and, directly underneath,
    // "It IMPROVED — write errors: 0 into UNLINTED_FRONTIER", which instructs the maintainer
    // to bank a gain that does not exist and to pin the collapse as the new normal. Two
    // messages pointing in opposite directions, one of which is the repair that erases the
    // finding.
    out.push(
      `  ${root}/: ${now.errors} lint error(s), pinned at ${pin.errors}. It IMPROVED by more\n`
      + `      than ${errSlack} — write errors: ${now.errors} into UNLINTED_FRONTIER in\n`
      + '      tools/lint-gate.mjs so the gain cannot be quietly lost again. A pin that only\n'
      + '      tightens when somebody remembers is a pin that never tightens.',
    );
  }
  return out;
}

export async function runLintGate() {
  // The programmatic API rather than the CLI: `eslint`'s package `exports` does not expose
  // `bin/eslint.js`, and more importantly a config-resolution failure here THROWS instead of
  // becoming an exit code that a caller could mistake for a clean run.
  let report;
  let eslint;
  try {
    eslint = new ESLint({ cwd: ROOT, errorOnUnmatchedPattern: false });
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
  // ★ THE RATCHET THE FLOOR NEVER HAD, and it found 34 files of slack the moment it ran. The
  // number above is hand-written and was corrected only when somebody happened to look, which
  // is how it came to sit further below the tree than the whole of `tools/`. The real count
  // is already in hand on every run, so the staleness is CHECKED rather than trusted and the
  // message carries the replacement number.
  if (report.length - MIN_FILES > FILE_FLOOR_ALLOWANCE) {
    failures.push(
      `  eslint linted ${report.length} file(s) but MIN_FILES is ${MIN_FILES} — `
      + `${report.length - MIN_FILES} below it, past the ${FILE_FLOOR_ALLOWANCE} of slack this\n`
      + '      floor is allowed. A floor that drifts far below reality stops being a floor.\n'
      + `      Raise MIN_FILES in tools/lint-gate.mjs to ${report.length - FILE_FLOOR_ALLOWANCE}.`,
    );
  }

  // Read separately from the lint results, like the file-count floor above: this is a claim
  // about the GATE, and no amount of clean linting can satisfy or refute it.
  let workflowText = null;
  try {
    workflowText = readFileSync(WORKFLOW, 'utf8');
  } catch {
    failures.push(
      '  .github/workflows/lint.yml could not be read. This gate exists because the linter\n'
      + '      had no workflow at all and its death went unnoticed; that file going missing\n'
      + '      is the same finding, so it is refused rather than skipped.',
    );
  }
  if (workflowText !== null) {
    const claimFailure = baselineClaimFailure(workflowText);
    if (claimFailure) failures.push(claimFailure);
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

  // ── ★ THE UN-LINTED FRONTIER. See UNLINTED_FRONTIER for why this is one number per root
  // rather than the ~185 per-file pins the expansion item asked for and was declined over.
  const frontier = {};
  for (const [root, pin] of Object.entries(UNLINTED_FRONTIER)) {
    let rootReport;
    try {
      rootReport = await lintTrackedUnder(eslint, root);
    } catch (err) {
      // Fail closed. "Could not scan" must not read the same as "scanned and unchanged".
      failures.push(
        `  ${root}/: eslint could not scan it (${err instanceof Error ? err.message : String(err)}).\n`
        + '      The frontier pin below is therefore unverified, which is the state this\n'
        + '      check exists to end.',
      );
      continue;
    }
    const now = {
      files: rootReport.length,
      errors: rootReport.reduce((n, f) => n + f.messages.filter(m => m.severity === 2).length, 0),
    };
    frontier[root] = now;
    failures.push(...frontierFailures(root, pin, now));
  }

  // ── ★ THE ROOT CENSUS: a NEW un-linted source root must not arrive silently. ────────────
  //
  // Every check above — the empty baseline, MIN_FILES, the frontier pins — is a statement
  // about directories somebody already named. None of them can observe a directory nobody
  // named. `applications/` itself arrived that way, and by the time anyone looked it held
  // 1,380 lint errors that no gate had ever seen. So the set of source roots is itself
  // pinned: a top-level directory with lintable source in it must be in TARGETS, in
  // UNLINTED_FRONTIER, or in CENSUS_EXEMPT with a reason. Adding a root and continuing is
  // then a deliberate act with a diff, which is all this asks for.
  let census;
  try { census = readdirSync(ROOT, { withFileTypes: true }); } catch { census = []; }
  const classified = new Set([...TARGETS, ...Object.keys(UNLINTED_FRONTIER), ...CENSUS_EXEMPT]);
  const unclassified = [];
  for (const e of census) {
    if (!e.isDirectory() || classified.has(e.name)) continue;
    if (e.name.startsWith('.')) continue;
    if (await hasLintableSource(eslint, join(ROOT, e.name))) unclassified.push(e.name);
  }
  if (unclassified.length > 0) {
    failures.push(
      `  un-linted source root(s) with no entry anywhere: ${unclassified.join(', ')}\n`
      + '      Each holds at least one file eslint.config.js would lint, and nothing in this\n'
      + '      gate knows about it. Put it in TARGETS (and fix its errors), or in\n'
      + '      UNLINTED_FRONTIER with its measured counts, or in CENSUS_EXEMPT with a reason.\n'
      + '      `applications/` reached 1,380 unobserved errors by being in none of the three.',
    );
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return { ok: failures.length === 0, failures, files: report.length, total, frontier, fatal: null };
}

/** The message a human or a CI log sees. Kept out of the checker so callers can reuse it. */
export function lintGateReport(result) {
  if (result.ok) {
    // The zero case gets its own sentence: "0 known error(s) across 0 baselined file(s)" is
    // technically true and reads like a gate that checked nothing, which is the one thing
    // this file must never be mistaken for. The file COUNT is in both, because that is the
    // number that distinguishes a clean run from a collapsed one.
    const pinned = Object.keys(BASELINE).length;
    // ★ THE FRONTIER IS PRINTED ON SUCCESS, NOT ONLY ON FAILURE. A green line reading "329
    // files linted, 0 errors" over a repo carrying 1,762 errors in two un-linted roots is
    // true and misleading in exactly the way this file keeps having to correct. The debt
    // that is deliberately not fixed yet should be visible on every run that passes.
    const frontier = Object.entries(result.frontier ?? {})
      .map(([root, n]) => `${root}/ ${n.errors} err in ${n.files} files`)
      .join('; ');
    const tail = frontier === '' ? '' : ` Un-linted frontier, pinned and not growing: ${frontier}.`;
    return pinned === 0
      ? `lint gate: ${result.files} file(s) linted, 0 errors, 0 baselined files — the `
        + `baseline is empty, so any error anywhere now fails this gate.${tail}`
      : `lint gate: ${result.files} file(s) linted, ${result.total} known error(s) across `
        + `${pinned} baselined file(s), none anywhere else.${tail}`;
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
