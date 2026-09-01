/**
 * THE LIVE THINGS OUTSIDE THIS PROCESS THAT MORE THAN ONE TEST MODULE SHARES — and, beside
 * them, the rule by which that set was derived, so the word "the" above is earned rather than
 * asserted.
 *
 * ★ WHY THIS FILE EXISTS AT ALL. Someone measuring whether the test pool can drop
 * `poolOptions.forks.singleFork` asked "does any test fetch a shared resource?", grepped the
 * `*.test.ts` files under `tests/`, and concluded "NO test fetches a shared pod". Three things
 * were wrong at once and each is a separate lesson:
 *
 *   1. `tests/` is 233 of the 329 modules vitest collects on this tree — 328 before the test
 *      beside this file, which is how CLAUDE.md came to say "328 test modules" one week and be
 *      wrong the next; it now points at the count rather than quoting one. Every pod suite
 *      lives in the other 96, under `applications/**\/tests/`. Re-measured here with
 *      `grep -lE '(^|[^.[:alnum:]_])fetch\('` over all 329: 15 modules call bare `fetch(`, and
 *      only 5 of them are under `tests/`. A different pattern gives a different count; what
 *      does not change is the RATIO — scanning `tests/` alone sees about a third of them.
 *   2. The pod target is not IN a test file. It is `pod-target.ts`, a HELPER — so no grep over
 *      `*.test.ts` could ever have reached it, at any scope. That is why the census below
 *      resolves each module's relative imports before fingerprinting it.
 *   3. The old comment in `vitest.config.ts` said "Azure CSS pod". Azure WAS destroyed, which
 *      made the sentence read like a description of something gone. The hazard had MIGRATED to
 *      Railway with the rest of the stack, keeping the same shape: one container, five suites.
 *
 * So the property "these tests share one live resource" was true, load-bearing, and not
 * discoverable from any file a reader of the pool config would open. This module is the one
 * place that states it, `shared-live-externals.test.ts` is what keeps every field below true,
 * and the `poolOptions` comment in `vitest.config.ts` points here.
 *
 * ★★ AND THE FIRST VERSION OF THIS FILE SAID "THE THREE LIVE THINGS" WHILE MISSING THE ONLY
 * ONE CI ACTUALLY ARMS. `RUN_PUBLIC_RELAY` — a third-party Nostr relay — is read by two
 * collected modules and set UNCONDITIONALLY by `.github/workflows/public-relay-interop.yml`,
 * which supplies a literal fallback so the job arms it whether or not the repo variable
 * exists. A list hand-assembled by someone who already knew what was on it cannot be complete,
 * and its being wrong is not the surprising part; what is worth fixing is that nothing could
 * TELL it was wrong.
 *
 * So the completeness claim is now DERIVED, by `shared-live-externals.test.ts`, from a rule:
 *
 *     every environment variable read by two or more collected modules is either claimed by
 *     an entry below, or listed in SHARED_BUT_NOT_LIVE with a reason
 *
 * plus the two closures that make that rule sufficient: `LIVE_BUT_NOT_SHARED` pins the
 * externals reached by exactly ONE module, so a second one arriving is red rather than silent,
 * and a separate scan asserts that no collected module PASSES a non-loopback literal address to
 * a dial.
 *
 * ★ THAT SECOND CLOSURE IS DIAL-SCOPED, AND THE SCOPE IS THE WHOLE DIFFICULTY. The obvious
 * version — "no collected module CONTAINS a non-loopback literal URL" — is unusable: measured,
 * 170 of the 329 collected modules carry one, across 80 distinct hosts, almost all of them
 * allowlist fixtures, SSRF cases, xAPI verb IRIs and JSON-LD context URLs that nothing dials.
 * So the scan reads only the ARGUMENTS of a call that dials, which it takes by matching
 * parentheses rather than by reading one line. The line-only version this replaces was false in
 * a way its own comment then asserted as fact: a single line break between `fetch(` and the URL
 * hid the address completely.
 *
 * That is the whole lens, and it is written down so the next reader knows what it cannot see:
 * a live thing reached with NO environment variable and NO literal URL inside the dial — an
 * address bound to a name first, assembled at runtime, or read out of a fixture file — is
 * outside it. Binding it first was tried as a third closure and withdrawn: following
 * `const X = 'http…'` into a dial that mentions `X` flags
 * `applications/lrs-adapter/tests/tier3b-xapi-conformance.test.ts`, where the constant is the
 * xAPI verb IRI `http://adlnet.gov/expapi/verbs/completed` going into a query string. An
 * exemption list for that is precisely where the next false record would land.
 *
 * ★★ AND THE IMPORT CLOSURE USED TO STOP AT THE `tests/` BOUNDARY, WHICH IS THE SAME HOLE ONE
 * DIRECTORY OVER. Reason 2 above — the pod target is in a HELPER, so no scan of `*.test.ts`
 * could reach it — was answered by resolving each module's relative imports before
 * fingerprinting it. But the walk then followed a specifier only when the file it named was
 * itself under a `tests/` directory. A suite reaching a shared external through a helper one
 * directory over was therefore invisible for exactly the reason a suite reaching it through
 * `pod-target.ts` had been: the deciding text is not in the file being fingerprinted. The
 * reviewer demonstrated it with a control — a helper OUTSIDE `tests/` reading the real write
 * credential, and a suite importing it — and the pod census stayed at five.
 *
 * The walk now follows a relative specifier wherever it leads inside the repository. Measured
 * on this tree: 139 of the 329 collected modules have a closure that leaves the test tree, 196
 * files the old boundary excluded are now read, and the four censuses below report exactly the
 * same consumers they did before — the widening added reach, not noise.
 *
 * ★ WHAT THE CLOSURE STILL CANNOT SEE, stated rather than implied, because "follows imports"
 * sounds like completeness and is not:
 *
 *   · A NON-RELATIVE SPECIFIER, including the workspace packages. `@interego/pgsl-store` is
 *     this repository's own code and resolves inside it, but the walk matches specifiers
 *     beginning with a dot. Measured on this tree: 607 such import edges across 30 distinct
 *     `@interego/*` specifiers appear in the files the closure already reaches, so this is the
 *     largest single gap, and it is a gap in REACH — a module reached only that way is
 *     fingerprinted as if it did not exist.
 *   · A DYNAMIC SPECIFIER THAT IS NOT A LITERAL — `await import(someVariable)`, a path built by
 *     concatenation, a specifier read out of a fixture or a manifest.
 *   · ANYTHING A SPAWNED PROCESS REACHES. A suite that runs `git`, `node`, `npx` or a container
 *     dials through a process this scan never opens; the census sees the argument list, not the
 *     child's imports.
 *   · A FILE GIT DOES NOT LIST — ignored, generated at run time, or resolved out of
 *     `node_modules`.
 *   · AND THE DIAL SCAN IS NARROWER STILL: the literal-address scan below reads each collected
 *     module's OWN text, not its closure, so a literal public address handed to a dial inside
 *     any helper is outside it. The environment-variable rule is the closure-wide half of that
 *     pair; there is no closure-wide literal scan, because production code legitimately dials
 *     the hosts it is configured with.
 *
 * ★ A GATE, NOT A DELETION. Nothing here turns a suite off. Each entry records switches that
 * ALREADY exist — in `real-pod-gate.ts`, `lrsql-gate.ts`, and the public-relay suites' own
 * module scope — plus the MEASURED fact of whether CI throws any of them. Say
 * DORMANT-BY-CREDENTIAL, never ABSENT: every assertion is still there, and the maintainer runs
 * them for real.
 *
 * Not collected by vitest (its include is `*.test.ts`); compiled by the typecheck gate, whose
 * tsconfig.check.json includes `applications/**\/tests/**\/*.ts`.
 */

export interface SharedLiveExternal {
  /** Stable key; appears in every failure message from the test beside this file. */
  readonly id: string;
  /** What it is and where it answers. */
  readonly address: string;
  /**
   * Why two test modules running at the same instant contend for it. This is the field the
   * parallelism question actually turns on — not "is it remote" but "is it ONE of them".
   */
  readonly contention: string;
  /** Env vars whose presence ARMS it. All unset means the modules below skip, loudly. */
  readonly armedBy: readonly string[];
  /** Env vars that force it OFF even when armed. An empty list would mean no off switch. */
  readonly offSwitch: readonly string[];
  /** Env vars that point it somewhere else — a local server, a second container. */
  readonly retargetedBy: readonly string[];
  /**
   * Consumers that deliberately do NOT read one of the names above, each argued.
   *
   * ★ WHY THIS FIELD EXISTS RATHER THAN A LOOSER RULE. The check that these switches are really
   * READ used to run over the POD entry alone, so replacing `lrsql-gate.ts`'s off switch with a
   * literal `false` went undetected. Generalising it needs a decision about strength, and the
   * weak form — "the name is read SOMEWHERE among this entry's consumers" — reintroduces the
   * same blindness one level up: `SKIP_LRSQL_TESTS` is read by lrsql-gate AND, separately, by
   * lrs-adapter's tier8, so a union would stay green while tier3 and tier3b stopped honouring
   * it entirely. The rule is therefore PER CONSUMER, which means every genuine asymmetry has to
   * be written down instead of averaged away — and writing the first one down turned out to
   * record something worth knowing rather than an excuse. Both directions are asserted: an
   * exception naming a module that DOES read the name is red too, so one cannot outlive its
   * reason.
   */
  readonly switchExceptions: readonly {
    readonly name: string;
    readonly module: string;
    readonly why: string;
  }[];
  /**
   * Workflow files that SET any `armedBy` var — MEASURED by listing `.github` from git
   * (tracked plus untracked-and-not-ignored) and reading each file, then asserted. Empty means
   * CI runs those modules as permanent skips.
   *
   * "Sets" means an assignment that survives YAML comment-stripping, which is not a detail:
   * the first version of that scan matched `PGSL_PG_IT=1` inside a PROSE COMMENT in
   * lrs-adapter-conformance.yml and reported that workflow as arming pgsl-store. Same defect
   * class as everything else in this area — a text match standing in for a read.
   *
   * A name being set is still not proof of a VALUE: the SCORM entry's three names are set from
   * repository secrets, and whether those secrets exist is not observable from this tree.
   */
  readonly armedInCi: readonly string[];
  /** Repo-relative test modules that reach it. Asserted EXHAUSTIVE against `fingerprints`. */
  readonly touchedBy: readonly string[];
  /**
   * What makes a module a consumer, matched against the module's own text AND against the text
   * of every module it transitively imports through a relative specifier — wherever in the
   * repository that leads, not only inside `tests/`. Deliberately narrow, because matching
   * the bare host name is the obvious idea and it does not work: measured on this tree with
   * `grep -l` over the 329 collected modules, the pod's OWN host `gate.interego.xwisee.com`
   * appears in 17 of them and `relay.interego.xwisee.com` in 33, while five modules reach the
   * pod. The rest carry the string in an allowlist fixture, an SSRF assertion or a URL-parsing
   * case and dial nothing. A fingerprint that flags 12 innocents cannot flag the 13th guilty
   * one, so membership is a READ of a credential or an IMPORT of a gate, never a mention.
   *
   * Build them with `helperImport` and `envRead` rather than by hand. The hand-written ones
   * hardcoded SINGLE quotes, so a suite written with double quotes — or with
   * `await import(...)`, the idiom the test file beside this one uses itself — passed the
   * census while genuinely calling `openRealPod()`. Nothing would have flagged either: driven
   * by swapping a pod suite's specifier to double quotes, eslint's output for that file was
   * unchanged (no rule here governs quote style), and the census stayed green.
   */
  readonly fingerprints: readonly RegExp[];
}

/**
 * A module specifier ending in `<basename>.js`, in every form this repo actually writes:
 * `from '…'`, `from "…"`, a backtick specifier, `await import('…')`, `require('…')`.
 *
 * It errs toward OVER-reporting — `// import from 'real-pod-gate.js'` inside a comment matches
 * — and that direction is deliberate. An over-report is a red census with a filename in the
 * message; an under-report is the green tick this whole area exists to stop.
 */
export function helperImport(basename: string): RegExp {
  return new RegExp(
    String.raw`(?:from|import|require)\s*\(?\s*(['"\x60])[^'"\x60]*`
    + basename + String.raw`\.js\1`,
  );
}

/**
 * A READ of `process.env.NAME`, in every spelling this repo could write — not a mention of the
 * name in prose.
 *
 * ★★ THE THIRD SPELLING IS DESTRUCTURING, AND LEAVING IT OUT WAS A DOOR A REVIEWER WALKED
 * STRAIGHT THROUGH. `const { INTEREGO_POD_WRITE_SECRET } = process.env;` is the ordinary way to
 * take several names at once, and the first two branches see nothing in it. Driven: a sixth pod
 * suite reading the real write credential that way, and PUTting to the live shared container,
 * was invisible to every census in this registry — it is exactly the "sixth suite" the pod
 * entry's second fingerprint exists to catch, arriving through the one door still open.
 *
 * ★ AND THE GAP WAS NOT FINDABLE BY SCANNING, WHICH IS WHY IT SURVIVED A CENSUS BUILT TO FIND
 * exactly this. No module the census scans destructures `process.env`: measured on 843fc4fa,
 * the only `{…} = process.env` occurrences under the collected roots are the ten SAMPLES inside
 * string literals in `shared-live-externals.test.ts`, which the census excludes from itself.
 * A hole with no instances in the tree has nothing for a scan to notice; it can only be walked
 * through.
 *
 * The brace body is `[^{}]*`, a negated class, so it crosses newlines and the multi-line form
 * is covered. It stops at a nested brace rather than balancing one: a pattern that nests is
 * destructuring something other than a top-level env name.
 *
 * ★ WHAT IT STILL DOES NOT SEE, stated rather than implied — an ALIAS. Binding `process.env` to
 * a name and reading THAT (`e.SKIP_POD_TESTS`, or `const { X } = e`) is a read no regex can
 * follow without resolving bindings. Measured on 843fc4fa with comment lines dropped: ZERO
 * identifiers under the collected roots are bound to a bare `process.env`. Every `= process.env`
 * a careless pattern finds there is a `process.env['NAME']` property read whose prefix it
 * matched — which is itself worth writing down, because that is how the loose count was got
 * wrong the first time. So this is a limit rather than a live hole, and it is named again in the
 * registry header, where the lens as a whole is described.
 */
export function envRead(name: string): RegExp {
  return new RegExp(
    String.raw`process\.env(?:\.` + name + String.raw`\b|\[\s*(['"])`
    + name + String.raw`\1\s*\])`
    + String.raw`|\{[^{}]*\b` + name + String.raw`\b[^{}]*\}\s*=\s*process\.env\b`,
  );
}

/**
 * ★ ONE CONTAINER, FIVE SUITES, AND TIER 2 WRITES AT ITS ROOT.
 *
 * `pod-target.ts` derives `TEST_POD_BASE` as `<POD_HOST>/<INTEREGO_TEST_POD ?? u-pk-...>/` — a
 * single default container for all five. The Tier 8 suites each mint a per-run sub-container
 * (`uniquePodUrl()`), so they contend only for the pod's storage and its gate; TIER 2 DOES NOT.
 * It publishes at the container root, so its manifest writes land in that pod's ONE shared
 * `.well-known/context-graphs`. `publish()` makes those CAS-safe with HTTP If-Match
 * (packages/solid/src/client.ts, `If-Match` at :1506 and :3068 on 843fc4fa), so a concurrent
 * writer retries rather than clobbering — correctness holds, but every retry is a round trip.
 */
const POD: SharedLiveExternal = {
  id: 'pod',
  address: 'the Railway css-gate, https://gate.interego.xwisee.com/u-pk-6e3bc2f9723c/ by default',
  contention: 'ONE container for all five suites; tier2 publishes at its root, into that pod\'s '
    + 'single shared .well-known/context-graphs manifest',
  armedBy: ['INTEREGO_POD_WRITE_SECRET', 'FOXXI_POD_WRITE_SECRET'],
  offSwitch: ['SKIP_POD_TESTS', 'SKIP_AZURE_TESTS'],
  retargetedBy: ['INTEREGO_POD_BASE', 'AZURE_CSS_BASE', 'INTEREGO_TEST_POD'],
  // None, and that is the shape to want: all five suites reach every one of the seven names
  // through the same two helpers, so there is no way for one of them to stop honouring a
  // switch on its own.
  switchExceptions: [],
  // MEASURED on 843fc4fa: no tracked workflow sets either name. bridge-typecheck.yml's "The
  // whole root test suite" step runs a bare `npx vitest run` with no `env:` block, so all 22
  // bodies below are permanent CI skips. The test beside this file re-measures BOTH halves of
  // that sentence — the absence of an arming workflow AND the existence of that step — so the
  // day CI arms them this goes red.
  armedInCi: [],
  touchedBy: [
    'applications/_shared/tests/tier2-azure-css.test.ts',
    'applications/agent-collective/tests/tier8-real-pod-end-to-end.test.ts',
    'applications/agent-development-practice/tests/tier8-real-pod-end-to-end.test.ts',
    'applications/learner-performer-companion/tests/tier8-real-pod-end-to-end.test.ts',
    'applications/lrs-adapter/tests/tier8-real-pod-end-to-end.test.ts',
  ],
  fingerprints: [
    // Importing the gate is the sanctioned route in; importing pod-target directly is the
    // BYPASS, and is fingerprinted here precisely so a sixth suite that skips openRealPod()
    // still shows up rather than hiding from the census.
    helperImport('real-pod-gate'),
    helperImport('pod-target'),
    envRead('INTEREGO_POD_WRITE_SECRET'),
    envRead('FOXXI_POD_WRITE_SECRET'),
  ],
};

/**
 * ★ A FIXED PORT ON LOOPBACK IS A SHARED RESOURCE TOO. Every other listener in this tree binds
 * port 0; this one is pinned to 8080 because a container publishes it there. Three modules dial
 * it, so two of them running at once queue on one LRS — and a developer with anything else on
 * 8080 gets that instead.
 */
const LRSQL: SharedLiveExternal = {
  id: 'lrsql',
  address: 'Yet Analytics Lrsql on the FIXED port http://localhost:8080/xapi',
  contention: 'one container on one pinned port, and the only port in the test tree a test '
    + 'expects something to be LISTENING on. Measured: every server the tree starts binds '
    + 'port 0 on 127.0.0.1 (the three .listen() calls, in egress-dns-screen, '
    + 'egress-invoke-deadline and personal-bridge), and the other literal loopback ports in '
    + 'it — :9, :1, :3456, :6080, :45999, :3000, :3306 — are refusal addresses, SSRF '
    + 'fixtures or in-memory pod base URLs that nothing dials expecting an answer',
  // LRSQL_IT is a DECLARATION, not a detection — see lrsql-gate.ts. Under it, unreachable is a
  // failure rather than a skip.
  armedBy: ['LRSQL_IT'],
  offSwitch: ['SKIP_LRSQL_TESTS'],
  retargetedBy: [],
  // ★ AN ASYMMETRY THE PER-CONSUMER RULE FORCED INTO THE OPEN, not a formality. Under
  // LRSQL_IT=1 — the CI job that stands the container up — tier3 and tier3b FAIL on an
  // unreachable LRS, because `requireLrsql()` throws. lrs-adapter's tier8 does not read
  // LRSQL_IT at all: its `lrsqlReachable()` probes, and `if (!lrsUp)` prints a warning and
  // leaves every LRS body skipped. So the provisioning job's fail-closed guarantee covers two
  // of its three consumers, and the third stays green if the container it provisioned never
  // came up. That is a finding, recorded here rather than smoothed over by a rule that only
  // asked whether SOMEBODY read the name.
  switchExceptions: [{
    name: 'LRSQL_IT',
    module: 'applications/lrs-adapter/tests/tier8-real-pod-end-to-end.test.ts',
    why: 'tier8 probes for the LRS and skips its LRS bodies when it is absent; it never '
      + 'consults LRSQL_IT, so the declaration that makes an unreachable LRS a FAILURE in '
      + 'tier3/tier3b does not reach this suite. Its pod half is separately fail-closed '
      + 'through openRealPod(); it is only the LRS half that is a plain skip.',
  }],
  armedInCi: ['.github/workflows/lrs-adapter-conformance.yml'],
  touchedBy: [
    'applications/lrs-adapter/tests/tier3-real-lrs.test.ts',
    'applications/lrs-adapter/tests/tier3b-xapi-conformance.test.ts',
    'applications/lrs-adapter/tests/tier8-real-pod-end-to-end.test.ts',
  ],
  // tier3/tier3b reach it through the gate; tier8 hardcodes the endpoint and runs its own
  // probe, which is exactly the bypass shape the second fingerprint exists to catch.
  fingerprints: [helperImport('lrsql-gate'), /localhost:8080/],
};

/**
 * ★ A THIRD PARTY'S SANDBOX. No workflow can stand one up, so the credentials ARE the
 * declaration that it exists; tier3c is fail-closed once they are supplied. Shared in the
 * strongest sense — it is not ours, and two modules POST real Statements into one tenant.
 */
const SCORM_CLOUD: SharedLiveExternal = {
  id: 'scorm-cloud',
  address: "Rustici SCORM Cloud's sandbox LRS, wherever SCORM_CLOUD_ENDPOINT points",
  contention: 'a single third-party tenant; both modules POST real Statements into it',
  armedBy: ['SCORM_CLOUD_ENDPOINT', 'SCORM_CLOUD_KEY', 'SCORM_CLOUD_SECRET'],
  // No dedicated off switch, and that is not an omission: unsetting the credentials IS the off
  // switch, because there is no ambient way to reach a tenant whose keys you do not hold.
  offSwitch: [],
  retargetedBy: ['SCORM_CLOUD_ENDPOINT'],
  // Both consumers read all three names directly, so the per-consumer rule has nothing to
  // excuse — and it is strictly stronger than a union would be here, since a union would stay
  // green if either suite stopped reading a credential it still POSTs with.
  switchExceptions: [],
  // The workflow sets all three from `secrets.*`, so this records that the NAMES are set in
  // that job. Whether the secrets exist is not readable from this tree, and the step is
  // written to go live the moment they do.
  armedInCi: ['.github/workflows/lrs-adapter-conformance.yml'],
  touchedBy: [
    'applications/lrs-adapter/tests/tier3c-scorm-cloud.test.ts',
    'applications/lrs-adapter/tests/tier8-real-pod-end-to-end.test.ts',
  ],
  // A READ of the credential, not a mention of its name: measured — of the four collected
  // modules carrying the string `SCORM_CLOUD`, `applications/lrs-adapter/tests/
  // readme-coverage-claim.test.ts` holds it inside `/lrsql|yetanalytics|SCORM_CLOUD/i`, a regex
  // auditing a workflow's provisioning markers, and dials nothing. Naming a service is not
  // reaching it.
  fingerprints: [
    envRead('SCORM_CLOUD_ENDPOINT'),
    envRead('SCORM_CLOUD_KEY'),
    envRead('SCORM_CLOUD_SECRET'),
  ],
};

/**
 * ★★ THE ONE CI ARMS, AND THE ONE THE FIRST CENSUS MISSED.
 *
 * A public Nostr relay belonging to somebody else. `public-relay-interop.yml` sets
 * `RUN_PUBLIC_RELAY` from a repo variable with a LITERAL fallback, so the job arms it
 * unconditionally — nightly, and on any pull request touching `packages/p2p`. Every other
 * entry here is dormant on the runner; this one runs.
 *
 * Shared twice over. Both modules open `WebSocketRelayMirror`s to the SAME relay and publish
 * signed kind-30040 events into it, and tier4's assertion is specifically that the relay
 * REDISTRIBUTES to a second client — so it needs two live connections at once, against
 * infrastructure that caps concurrent connections per source IP and that GitHub runners reach
 * from a shared egress address.
 *
 * There is no separate off switch and none is missing: `RUN_PUBLIC_RELAY` is read raw with no
 * default, so unsetting it IS off, and the same variable chooses the relay. That is why it is
 * both `armedBy` and `retargetedBy` — one variable doing two jobs, which is worth seeing.
 */
const PUBLIC_RELAY: SharedLiveExternal = {
  id: 'public-relay',
  address: 'a third-party Nostr relay at whatever RUN_PUBLIC_RELAY names; the workflow falls '
    + 'back to wss://relay.primal.net',
  contention: 'one relay somebody else operates; tier4 needs TWO simultaneous client '
    + 'connections through it, and public relays cap concurrency per source IP',
  armedBy: ['RUN_PUBLIC_RELAY'],
  offSwitch: [],
  retargetedBy: ['RUN_PUBLIC_RELAY'],
  // One variable, read raw by both suites at module scope. Nothing to excuse.
  switchExceptions: [],
  armedInCi: ['.github/workflows/public-relay-interop.yml'],
  touchedBy: [
    'applications/agent-collective/tests/tier4-public-relay.test.ts',
    'tests/p2p-public-relay.test.ts',
  ],
  fingerprints: [envRead('RUN_PUBLIC_RELAY')],
};

export const SHARED_LIVE_EXTERNALS: readonly SharedLiveExternal[] =
  [POD, LRSQL, SCORM_CLOUD, PUBLIC_RELAY];

/**
 * The scan's roots, mirroring `vitest.config.ts`'s `include`. `deploy/` is deliberately out: no
 * vitest include reaches it, and its suites run from `npm run test:deploy`.
 */
export const COLLECTED_ROOTS: readonly string[] = ['tests', 'applications', 'integrations', 'mcp-server'];

/**
 * Read by two or more collected modules, and NOT a live external. Each of these has to be
 * argued, because the completeness rule above cannot tell a shared service from a shared
 * constant on its own — and an unexplained name here is how the next `RUN_PUBLIC_RELAY` gets
 * waved through. Adding a line is a decision; the test refuses to let it be an omission.
 */
export const SHARED_BUT_NOT_LIVE: readonly { readonly name: string; readonly why: string }[] = [
  // ★ EMPTY, AND THAT IS A MEASUREMENT RATHER THAN AN OVERSIGHT. Re-measured on the widened
  // closure: 34 names are read by two or more collected modules, 13 of them belong to an entry
  // above, and the other 21 are shared ONLY through production code the tests import — they are
  // in SHARED_ONLY_THROUGH_IMPORTED_CODE below, which is a different fact about a name and is
  // kept a different list for that reason. Nothing is left over. This list stays for the case
  // this repository does not currently have: a name two or more modules read IN THE TEST TREE
  // that addresses nothing outside the process.
  //
  // The single candidate that once looked like it needed a line — FOXXI_WALLET_SEED — is read
  // in the TEST TREE by exactly ONE module, `applications/foxxi-content-intelligence/tests/
  // public-memory-commons.test.ts`. (Through the closure it now measures as 18, all of them
  // reaching the one read in `foundation-holon-altitude.ts`; that is what the entry for it
  // below records.) Over RAW text it once measured as two, because
  // `tests/personal-bridge.test.ts` carries the literal `process.env.FOXXI_WALLET_SEED` inside a
  // paragraph explaining a different file and reads nothing; the first version of this list then
  // excused the pair with a sentence claiming both readers assign it a fixed test value, which
  // was false of the one that is not a reader at all. See `envNamesOf` in the test beside this
  // file, which strips comment lines precisely because that false record got written.
];

/**
 * ★★ WHAT THE WIDENED CLOSURE ACTUALLY YIELDED: names two or more collected modules read, but
 * only through the PRODUCTION code they import. Not one of them is read by two modules in the
 * test tree — the test beside this file asserts that, per entry, which is what keeps this list
 * about the widening rather than a second place to excuse a test-tree read.
 *
 * Each entry names the read site so the claim can be checked in one hop, and the test asserts
 * that file exists, is outside the test tree, and really contains a read of that name. An entry
 * whose read site stops reading it is red, in the same both-directions discipline as
 * `switchExceptions` and `IMPORTS_BUT_NEVER_DIALS`.
 *
 * ★★ TWO OF THE TWENTY-ONE ADDRESS SOMETHING LIVE, AND THAT IS THE FINDING RATHER THAN AN
 * EMBARRASSMENT. `FOXXI_TENANT_POD_URL` (with `FOXXI_AUTHORITATIVE_SOURCE`) names a real Solid
 * pod that `pod-snapshot-publisher.ts` writes to with `globalThis.fetch`, and
 * `RELAY_PGSL_PG_CONNSTR` names a real PostgreSQL that `engagement-store.ts` opens. They are
 * here rather than in `SHARED_LIVE_EXTERNALS` because of a fact that is MEASURED, not assumed:
 * nothing in this tree and no workflow sets any of the three, and every dial behind them is
 * guarded by the value being present — `podConfig()` returns null, `createStatementStore('pod')`
 * throws before constructing anything, `isConfigured()` is false and
 * `defaultEngagementStore()` returns null. The test asserts the unset half, over the tree and
 * over `.github`, so the day one of them is armed this goes red.
 *
 * What that leaves is worth saying plainly rather than filing away: an operator who exports
 * `FOXXI_TENANT_POD_URL` and `FOXXI_AUTHORITATIVE_SOURCE` in their shell configures a live pod
 * into the 22 collected modules that reach that read, and every one of them which exercises the
 * snapshot publisher would then write into it. Unlike the pod credential — whose absence prints
 * a skip naming itself — nothing announces either state, which is why the guard is a scan for a
 * SETTER rather than a note that says "leave these unset".
 */
export const SHARED_ONLY_THROUGH_IMPORTED_CODE: readonly {
  readonly name: string;
  /** The file whose read makes the name shared. Outside the test tree; asserted to read it. */
  readonly readIn: string;
  readonly why: string;
}[] = [
  {
    name: 'INTEREGO_BUILD_SHA',
    readIn: 'applications/_shared/vertical-bridge/index.ts',
    why: 'the build sha this process reports at /health, read once to answer that route. It '
      + 'entered the collected closure the same way PORT did — a second suite '
      + '(every-vertical-declines-with-a-status) began importing createVerticalBridge in order '
      + "to DRIVE each vertical's dispatcher rather than pattern-match its source, after a "
      + 'source census cleared three verticals that were answering HTTP 200 to declined calls. '
      + 'It names a stamp this deployment prints about itself; it addresses nothing outside the '
      + 'process, and no module in the test tree reads it.',
  },
  {
    name: 'PORT',
    readIn: 'applications/_shared/vertical-bridge/index.ts',
    why: 'a local bind port. It entered the collected closure when a refusal test began '
      + 'importing createVerticalBridge to drive the dispatcher over real HTTP; that test binds '
      + 'port 0 and reads the assigned port back off the server, so NO module in the test tree '
      + 'reads this name — which is why it belongs here rather than in SHARED_BUT_NOT_LIVE, '
      + 'whose criterion is two or more readers in the test tree. Ten modules under the '
      + 'collected roots read it, eight handing a parsed value to app.listen and TWO building a '
      + 'http://localhost default (vertical-bridge/index.ts and foxxi bridge/server.ts). It '
      + 'names a port this process binds; it addresses nothing outside it.',
  },
  {
    name: 'AGENT_SIG_REPLAY_WINDOW_MS',
    readIn: 'applications/foxxi-content-intelligence/src/auth.ts',
    why: 'a replay window in milliseconds, taken through Number() and used to bound how old a '
      + 'signed request may be. It configures arithmetic inside this process and addresses '
      + 'nothing outside it.',
  },
  {
    name: 'BRIDGE_DEPLOYMENT_URL',
    readIn: 'applications/foxxi-content-intelligence/src/course-identity.ts',
    why: 'the fallback naming authority the course, competency and activity id minters build '
      + '@id strings from — `${BASE}/agent/scorm/course/<id>`. All three read sites concatenate '
      + 'it into an identifier and none of those three files contains a fetch( at all, so what '
      + 'it names is MINTED here, and dereferenced by whoever holds the URL.',
  },
  {
    name: 'DEBUG_PROMOTION_CONSTRAINTS',
    readIn: 'applications/agent-collective/src/pod-publisher.ts',
    why: 'compared === \'1\' and used only to gate console.error lines inside constraint '
      + 'discovery. A logging switch, not a destination.',
  },
  {
    name: 'FOXXI_AUTHORITATIVE_SOURCE',
    readIn: 'applications/foxxi-content-intelligence/src/pod-snapshot-publisher.ts',
    why: 'the IRI the snapshot is attributed to, and the second half of the pod-backed LRS '
      + 'configuration: podConfig() returns null unless BOTH it and FOXXI_TENANT_POD_URL are '
      + 'set, and createStatementStore(\'pod\') throws naming whichever is missing. See the '
      + 'FOXXI_TENANT_POD_URL entry — the two are one switch, and the test asserts nothing in '
      + 'the tree or in CI sets either.',
  },
  {
    name: 'FOXXI_COMPETENCY_ID_BASE',
    readIn: 'applications/foxxi-content-intelligence/src/competency-identity.ts',
    why: 'the per-kind override of the identifier base above, read at module scope and joined '
      + 'into a competency IRI. An identifier authority, not a dial target.',
  },
  {
    name: 'FOXXI_COURSE_ID_BASE',
    readIn: 'applications/foxxi-content-intelligence/src/course-identity.ts',
    why: 'the per-kind override of the identifier base above, read at module scope and joined '
      + 'into a course IRI. An identifier authority, not a dial target.',
  },
  {
    name: 'FOXXI_ISSUER_KEY_SEED',
    readIn: 'applications/foxxi-content-intelligence/src/foundation-holon-altitude.ts',
    why: 'the second accepted spelling of the seed the bridge encryption keypair is derived '
      + 'from. Unset, bridgeEncryptionKeypair() returns null and the encrypted-holon altitude '
      + 'is skipped. A KEY, not an address: it decides which keypair encrypts, never where '
      + 'anything goes.',
  },
  {
    name: 'FOXXI_LATTICE_RETRY_BASE_MS',
    readIn: 'applications/foxxi-content-intelligence/src/foundation-shared-lattice.ts',
    why: 'the backoff base in milliseconds for a failed pod load, defaulted to 30_000 at module '
      + 'scope. It changes the timing of a dial the lattice was going to make anyway.',
  },
  {
    name: 'FOXXI_LATTICE_RETRY_MAX_MS',
    readIn: 'applications/foxxi-content-intelligence/src/foundation-shared-lattice.ts',
    why: 'the backoff ceiling in milliseconds, defaulted to 600_000 at module scope. Same read '
      + 'site and same argument as the base above.',
  },
  {
    name: 'FOXXI_LRS_MEMORY_MAX_STATEMENTS',
    readIn: 'applications/foxxi-content-intelligence/src/statement-store.ts',
    why: 'an override for the resident statement budget, which is otherwise derived from the '
      + 'V8 heap limit. A cap on an in-memory Map; nothing outside the process is named.',
  },
  {
    name: 'FOXXI_TENANT_POD_URL',
    readIn: 'applications/foxxi-content-intelligence/src/pod-snapshot-publisher.ts',
    why: 'GENUINELY A LIVE ADDRESS — a Solid pod that podConfig() hands to a globalThis.fetch '
      + 'writer, and that createStatementStore(\'pod\') builds a PodStatementStore over. It is '
      + 'not an entry above because nothing in this tree and no workflow sets it, and every '
      + 'path behind it is guarded on the value being present, so no collected module reaches '
      + 'that pod. An operator who exports it and FOXXI_AUTHORITATIVE_SOURCE would give 22 '
      + 'collected modules one live pod to write into, with nothing printed to say so.',
  },
  {
    name: 'FOXXI_WALLET_SEED',
    readIn: 'applications/foxxi-content-intelligence/src/foundation-holon-altitude.ts',
    why: 'the preferred spelling of the encryption seed above, tried before '
      + 'FOXXI_ISSUER_KEY_SEED. It is the name whose reader count was got wrong twice — once by '
      + 'counting a mention in prose as a read, and once by counting only the test tree — so it '
      + 'is written down here with the read site that actually makes it shared.',
  },
  {
    name: 'INTEREGO_DISCORD_STATE',
    readIn: 'applications/shared-workspace/discord/src/links.ts',
    why: 'the path of a local JSON index, defaulting under the user home rather than into the '
      + 'working directory. Process-external state, but not a network one — and every '
      + '`new LinkStore(` under the collected roots passes an explicit path, so the default is '
      + 'not taken by any suite.',
  },
  {
    name: 'LOCALAPPDATA',
    readIn: 'applications/shared-workspace/desktop/src/turnsetup.ts',
    why: 'a Windows install root joined into the candidate paths searched when LOOKING FOR a '
      + 'node binary on disk. An operating-system variable, not a configuration of ours.',
  },
  {
    name: 'NS_FETCH_TIMEOUT_MS',
    readIn: 'deploy/mcp-relay/egress.ts',
    why: 'the deadline in milliseconds applied to a plain guarded fetch, defaulted to 15_000. '
      + 'It bounds a dial rather than choosing one.',
  },
  {
    name: 'NS_INVOKE_TIMEOUT_MS',
    readIn: 'deploy/mcp-relay/egress.ts',
    why: 'the same deadline for the longer invoke path, defaulted to 120_000. Same read site '
      + 'and same argument as the fetch timeout above.',
  },
  {
    name: 'PATH',
    readIn: 'applications/shared-workspace/desktop/src/turnsetup.ts',
    why: 'split on the platform delimiter to search the directories already on it for a node '
      + 'binary. The most ambient variable there is, and it addresses nothing of ours.',
  },
  {
    name: 'ProgramFiles',
    readIn: 'applications/shared-workspace/desktop/src/turnsetup.ts',
    why: 'the other Windows install root joined into the same candidate paths as LOCALAPPDATA, '
      + 'in the same search for a node binary on disk.',
  },
  {
    name: 'RELAY_ENGAGEMENT_MAX_BYTES',
    readIn: 'deploy/mcp-relay/engagement-store.ts',
    why: 'a per-record size cap in bytes, parsed at module scope and defaulted to 1_048_576. A '
      + 'refusal threshold inside the store, not a destination.',
  },
  {
    name: 'RELAY_PGSL_PG_CONNSTR',
    readIn: 'deploy/mcp-relay/engagement-store.ts',
    why: 'GENUINELY A LIVE ADDRESS — a PostgreSQL connection string, read at module scope. It '
      + 'is not an entry above because it is unset in this tree and in CI, isConfigured() is '
      + 'exactly the test that it is non-empty, and defaultEngagementStore() returns null when '
      + 'it is not. Both consumers build the store over an FdbLike of their own instead — an '
      + 'InMemoryFdb in engagement-durability, and in pgsl-store-pg-integration the Postgres '
      + 'its own PGSL_PG_IT job stands up, which is a different database reached a different '
      + 'way. Set this one and both would share it.',
  },
  {
    name: 'RELAY_PGSL_TABLE',
    readIn: 'deploy/mcp-relay/engagement-store.ts',
    why: 'the table name inside whatever the connection string above addresses, defaulted to '
      + 'relay_pgsl_published. It selects a name in a database this tree never opens.',
  },
];

/**
 * Genuinely live, genuinely external, and reached by exactly ONE collected module each — so
 * out of this registry's scope by its own definition, and that is the ONLY reason they are
 * absent. The count is asserted, so the day a second module reaches one of these the census
 * goes red and the answer is to promote it to an entry above.
 */
export const LIVE_BUT_NOT_SHARED: readonly { readonly name: string; readonly what: string }[] = [
  {
    name: 'PGSL_PG_IT',
    what: 'a real PostgreSQL, stood up as a service container by .github/workflows/pgsl-store-pg.yml',
  },
  {
    name: 'PGSL_FDB_IT',
    what: 'a real FoundationDB cluster, stood up by .github/workflows/pgsl-store-fdb.yml',
  },
];

/**
 * Collected modules that MATCH a fingerprint but provably never reach the external, listed
 * rather than silently excluded.
 *
 * `shared-live-externals.test.ts` really does `await import('./real-pod-gate.js')` and really
 * does call `openRealPod()` — that is the point of it, since a harness standing in for the gate
 * could not verify how the gate composes with `pod-target.ts`. It cannot dial the pod because
 * every case stubs all seven names the gate consults, and the one case that reaches `probePod()`
 * is pointed at 127.0.0.1:9.
 *
 * This is load-bearing, not decoration: empty it and the pod census reports six consumers.
 * MEASURED by doing exactly that — see the mutant note in the test file. The test also asserts
 * each entry still matches a fingerprint, so an exemption that has stopped doing anything goes
 * red rather than being inherited.
 */
export const IMPORTS_BUT_NEVER_DIALS: readonly string[] = [
  'applications/_shared/tests/shared-live-externals.test.ts',
];
