/**
 * The defects, as data. Each entry is a real one an audit found — or one a gate was written to
 * catch — paired with the gate that must go red for it.
 *
 * Adding a gate means adding a mutant here. That is the point: a gate arrives with the defect
 * it claims to catch, and the harness proves the claim rather than taking it.
 *
 * `find` must be verbatim from the file. If a refactor moves it, the harness FAILS rather than
 * skipping — a stale anchor means the gate is unverified, which is when you most want to know.
 */

const FOXXI = 'applications/foxxi-content-intelligence/bridge/server.ts';
const WSP = 'applications/shared-workspace/src/respond.ts';
const AGP = 'applications/agentic-performance-practice/bridge/handlers.ts';
const OWM = 'applications/organizational-working-memory/source-adapters/web.ts';
const LRS = 'applications/lrs-adapter/bridge/server.ts';
const AC_SRC = 'applications/agent-collective/src/pod-publisher.ts';
const FOXXI_SRC = 'applications/foxxi-content-intelligence/src/composed-extensions.ts';
const LPC_TTL = 'docs/applications/learner-performer-companion/lpc.ttl';
const STATUS_MD = 'STATUS.md';
const RUNBOOK = 'spec/OPS-RUNBOOK.md';
const LPC_README = 'applications/learner-performer-companion/bridge/README.md';
const RELAY = 'deploy/mcp-relay/server.ts';
const DISPATCHER = 'applications/_shared/vertical-bridge/index.ts';
const ROUTER = 'packages/pgsl/src/interrogative-router.ts';
const SEALER = 'packages/workspace-client/src/sealer.ts';
const OAUTH_STORE = 'deploy/mcp-relay/oauth-client-store.ts';
const GITATTRIBUTES = '.gitattributes';
const LPC_IMPL = 'applications/learner-performer-companion/src/institutional-publisher.ts';
const ADP_SHAPES = 'applications/agent-development-practice/ontology/adp-shapes.ttl';

/**
 * ★ BUILT BY CONCATENATION SO THE IRI NEVER APPEARS WHOLE IN THIS FILE.
 *
 * `tests/shape-namespaces-resolve.test.ts` now walks EVERY TRACKED FILE, tools/ included - so
 * an unpublished namespace written out literally here trips, on a clean tree, the very gate
 * this mutant exists to drive. The harness reported "the gates are already red before any
 * mutation was applied" and was exactly right.
 *
 * Same shape as the control-byte mutant spelling its 0x08 as an escape: a mutation table is
 * INPUT to the gates it drives, and a defect written plainly in it is a defect in the tree.
 * The gate's own path pattern stops at the quote, so the split IRI matches nothing.
 */
const UNPUBLISHED_NS = 'https://markjspivey-xwisee.github.io/interego/applications/'
  + 'agent-development-practice/adp/no' + 'where#';
const RETRY = 'packages/core/src/http/retry.ts';
const FOLLOW = 'packages/core/src/affordance/follow.ts';
const HYPER = 'packages/core/src/kernel/hypermedia.ts';
const KERNEL = 'packages/core/src/kernel/index.ts';

const REFUSAL_GATE = 'tests/a-refusal-answers-a-refusing-status.test.ts';
const STATUS_GATE = 'tests/a-refusal-status-names-what-actually-failed.test.ts';
const VERTICAL_GATE = 'tests/every-vertical-declines-with-a-status.test.ts';
const RETRY_GATE = 'tests/a-refusal-is-never-retried-as-a-blip.test.ts';
const BYTES_GATE = 'tests/line-endings-are-normalised.test.ts';
const TERMS_GATE = 'tests/every-published-term-is-declared.test.ts';
const NS_GATE = 'tests/shape-namespaces-resolve.test.ts';
const ADVERTISED_GATE = 'tests/advertised-commands-do-something.test.ts';
const OAUTH_SCOPE_GATE = 'deploy/mcp-relay/tests/oauth-read-scope-is-read-only.test.ts';
const CALLER_URL_GATE = 'deploy/mcp-relay/tests/caller-urls-go-through-the-guard.test.ts';
const DRIFT_GATE = 'tools/docs-drift-lint.mjs';
const README_COUNT_GATE = 'tests/a-readme-count-matches-what-the-bridge-mounts.test.ts';
const ROUTER_GATE = 'tests/interrogative-router.test.ts';
const INJECTION_GATE = 'tests/workspace-client-membership.test.ts';
/** The banked-allowance side of Turtle injection: the population may shrink, never grow. */
const IRI_RATCHET_GATE = 'tools/turtle-iri-ratchet.mjs';
/** What that ratchet counts, and where — the gate on the gate. */
const IRI_COUNTER_GATE = 'tests/a-turtle-site-is-counted-where-it-is-emitted.test.ts';
/** One IRI, one declaration, across every published ontology. */
const DUPLICATE_TERM_GATE = 'tests/no-term-is-declared-twice.test.ts';
/** sh:severity says how loudly a result speaks, never whether it counts — nesting included. */
const SEVERITY_GATE = 'tests/shacl-unsupported-severity.test.ts';
/** The frame the relay emits is an instance of the shape the relay publishes. */
const NOTIFICATION_FRAME_GATE = 'tests/a-notification-frame-is-an-instance-of-its-shape.test.ts';
/** A governance rule that declares a scope is enforced within it, and only within it. */
const SCOPED_CONSTRAINT_GATE = 'applications/agent-collective/tests/a-scoped-constraint-scopes.test.ts';
/** An input a capability advertises reaches the graph, or is refused. */
const ACCEPTED_INPUT_GATE = 'applications/agentic-performance-practice/tests/an-accepted-outcome-is-recorded.test.ts';
const NESTED_RETRY_GATE = 'tests/a-retry-is-not-nested-inside-a-retry.test.ts';
const PRIVACY_GATE = 'tests/an-advertised-privacy-mode-is-implemented-or-refused.test.ts';

/** An untyped decline planted in a real handler, in each shape that has defeated a census. */
const plant = (name, body, why) => ({
  name,
  file: FOXXI,
  find: '  const token = (args.__caller_token as string | undefined);',
  replace: `  if (args['__mutant']) return ${body};\n  const token = (args.__caller_token as string | undefined);`,
  mustFail: [REFUSAL_GATE],
  why,
});

export const MUTANTS = [
  // ── the census must SEE a decline, whatever shape it is written in ─────────
  plant('decline-plain', "{ error: 'forbidden — nope' }",
    'the simplest untyped denial there is'),
  plant('decline-nested-object', "{ error: 'forbidden — nope', detail: { why: 'nested' } }",
    'a nested object: `[^}]*` could not cross one, and every refusal that names a way out has one'),
  plant('decline-regex-literal', "{ error: 'forbidden — ' + String(args['x'] ?? '').replace(/\"/g, '') + ' no' }",
    'a regex literal: the hand-rolled scanner overran into the NEXT literal and excused this one'),
  plant('decline-regex-quote', "{ error: 'forbidden — ' + String(args['x'] ?? '').replace(/'/g, '') + ' no' }",
    'a quote inside a regex literal, which dropped the statement entirely'),
  plant('decline-paren-return', "({ error: 'forbidden — nope' })",
    '`return ({…})`, which the start pattern never matched'),
  plant('decline-bare-status', "{ error: 'forbidden — nope', status: 403 }",
    'a bare `status:` the dispatcher does not read — it answered 200 AND was excused'),
  plant('decline-reason-key', "{ reason: 'forbidden — not permitted here' }",
    '`reason:` rather than `error:` — twelve returns in this tree use it'),
  {
    name: 'decline-arrow-body',
    file: FOXXI,
    find: "  'foxxi.coverage_query': async (args) => {",
    replace: "  'foxxi.zz_mutant': async (_a) => ({ error: 'forbidden — admin only' }),\n"
      + "  'foxxi.coverage_query': async (args) => {",
    mustFail: [REFUSAL_GATE],
    why: 'an expression-bodied handler `=> ({…})`. The "23 handler entries" once quoted here was a misread grep - 22 of those hits are .map() callbacks and one is a local helper; an AST census finds ZERO such handler entries. The form is still worth a mutant: a parser must handle it, and nothing stops the next handler being written that way',
  },
  {
    name: 'okfalse-moved-into-handler',
    file: FOXXI,
    find: "  'foxxi.coverage_query': async (args) => {",
    replace: "  'foxxi.coverage_query': async (args) => {\n"
      + "    const _cast = (args['coverage'] as string[] | undefined) ?? [];\n"
      + "    if (args['__mutant']) return { ok: false, error: 'forbidden — admin only' };",
    mustFail: [REFUSAL_GATE],
    why: '`{ok:false}` is excluded as a helper idiom; §C must prove it never sits in a handler',
  },

  // ── a refusal's STATUS must mean what its reason says ──────────────────────
  {
    name: 'helper-notFound-becomes-401',
    file: FOXXI,
    find: "    'iep:refusalStatus': 404,\n    'iep:refusalReason': 'the referenced resource",
    replace: "    'iep:refusalStatus': 401,\n    'iep:refusalReason': 'the referenced resource",
    mustFail: [STATUS_GATE],
    why: 'the six status helpers stand behind seventy-odd call sites (an AST census counts 73; the "26" once written here was wrong by 2.7x when written) and were selected by no leg',
  },
  {
    name: 'helper-notConfigured-becomes-401',
    file: FOXXI,
    find: "    'iep:refusalStatus': 503,\n    'iep:refusalReason': 'the deployment lacks",
    replace: "    'iep:refusalStatus': 401,\n    'iep:refusalReason': 'the deployment lacks",
    mustFail: [STATUS_GATE],
    why: 'a deployment failure reported as the caller\'s credentials failing',
  },
  {
    name: 'wrongPod-drops-its-status',
    file: FOXXI,
    find: "    'iep:refusalStatus': 403,\n    'iep:refusalReason': 'this pod is administered elsewhere",
    replace: "    'iep:refusalReason': 'this pod is administered elsewhere",
    mustFail: [STATUS_GATE],
    why: 'leg 2 excused any refusal carrying a resolvedBy; wrongPod names an enrolment one',
  },
  {
    name: 'propagateRefusal-hardcodes-401',
    file: FOXXI,
    find: "    'iep:refusalStatus': r.status ?? 400,",
    replace: "    'iep:refusalStatus': 401,",
    mustFail: [STATUS_GATE],
    why: 'it exists to hand on the producer\'s status; a constant discards every 404/409/403',
  },

  // ── the other verticals ───────────────────────────────────────────────────
  {
    name: 'wsp-not-seated-untyped',
    file: WSP,
    find: "reason: 'not-seated' as const, kind: 'refusal' as const,",
    replace: "reason: 'not-seated' as const,",
    mustFail: [VERTICAL_GATE],
    why: 'an unauthorised caller told HTTP 200 — untyped in production for hours before an audit',
  },
  {
    name: 'wsp-ceiling-untyped',
    file: WSP,
    find: "reason: 'ceiling' as const, kind: 'refusal' as const,",
    replace: "reason: 'ceiling' as const,",
    mustFail: [VERTICAL_GATE],
    why: 'a role ceiling refusing a write, reported as success',
  },
  {
    name: 'agp-decline-untyped',
    file: AGP,
    // Verbatim the three lines that stood here before the fix. A mutant that does not COMPILE
    // proves nothing: the typecheck globalSetup throws before an assertion runs, and a
    // two-state harness would score that non-zero exit as "caught".
    find: "        return { ...refuse(400, 'Pass an inline `situation` object, or a `situation_iri` resolvable against `pod_url`. The engine ran nothing because no situation could be resolved.',\n          'no situation could be resolved from the arguments supplied'),\n          pending: 'situation-not-resolvable', tool: 'agp.diagnose', received: args };",
    replace: "        return { pending: 'situation-not-resolvable', tool: 'agp.diagnose', received: args };",
    mustFail: [VERTICAL_GATE],
    why: '`pending` was a third spelling of "no" that no word list anticipated',
  },
  {
    name: 'owm-ssrf-refusal-untyped',
    file: OWM,
    find: "      ...refuse(403, `refused: ${(e as Error).message}`,\n        'the caller named a target outside the address space this deployment will fetch') };",
    replace: "      };",
    mustFail: [VERTICAL_GATE],
    why: 'an SSRF refusal answering 200 - the caller cannot tell it from a successful fetch',
  },

  // ── a considered "no" is not a network blip ────────────────────────
  {
    name: 'transient-matcher-unanchored-again',
    file: RETRY,
    find: "const HTTP_5XX_INTRODUCED = /(?:\\bHTTP\\b\\s*|\\bstatus\\b\\W{0,2}|\\breturned\\s+|:\\s*)5\\d\\d(?![0-9A-Za-z])/i;",
    replace: "const HTTP_5XX_INTRODUCED = /5\\d\\d/;",
    mustFail: [RETRY_GATE],
    why: 'the original: 59% of sha1 addresses and 77% of sha256 ones contain a 5-digit-digit run, so a permanent 403 on a content-addressed descriptor was retried four times',
  },
  {
    name: 'follower-retries-a-declared-refusal',
    file: FOLLOW,
    find: "    if (r.status >= 500 && !declaresRefusal(text)) {",
    replace: "    if (r.status >= 500 && !declaresRefusal('')) {",
    mustFail: [RETRY_GATE],
    why: 'still CALLS declaresRefusal, so it compiles and the import stays used - but never on the body, so every 502 refusal is resent three more times',
  },
  {
    name: 'declaresRefusal-tests-the-wrong-word',
    file: HYPER,
    find: "        && (parsed as Record<string, unknown>)['kind'] === 'refusal',",
    replace: "        && (parsed as Record<string, unknown>)['kind'] === 'refused',",
    mustFail: [RETRY_GATE],
    why: 'the predicate itself: one letter turns every refusal back into a blip, and nothing else in the tree reads this function yet',
  },

  // ── a control byte spelled as itself ───────────────────────────────
  {
    name: 'a-raw-backspace-in-source',
    file: RETRY,
    // Verbatim the defect that produced this mutant: generating this regex through a layer of
    // escaping turned every `\\b` into a real 0x08, which deleted the word boundaries while
    // leaving a regex that still compiled. Invisible in the diff, the terminal and the grep.
    //
    // The escape below is deliberate: written as a raw byte, THIS FILE would trip the very
    // gate the mutant is meant to prove. JS reads it back as the same single character.
    find: "(?:\\bHTTP",
    replace: "(?:\u0008HTTP",
    // ★★ BOTH ENTRY POINTS, BECAUSE THE SCAN NOW HAS TWO. It moved into
    // tools/tracked-bytes-lint.mjs so an unfiltered CI step could run it without a compiler — the
    // vitest step that ran it before fired the typecheck globalSetup in a job that never builds,
    // and reported 1,616 phantom errors. A move like that is exactly where a check quietly stops
    // running at one of its callers, so the defect must go red at both.
    //
    // A mutant that NARROWED the scan back to `indexOf(0)` was tried instead and REMOVED: the tree
    // holds no non-NUL control byte, so both readings agree and it discriminated nothing. This one
    // plants the byte, so it does.
    mustFail: [BYTES_GATE, 'tools/tracked-bytes-lint.mjs'],
    why: 'the gate said "control byte" and checked only NUL, so 0x01, 0x07, 0x1b and five 0x08 all sat in tracked source',
  },

  {
    name: 'untyped-decline-in-an-undriven-vertical',
    file: LRS,
    // lrs-adapter is one of the five verticals NO leg drives. Before the all-mounts census
    // this planted decline reached a caller as HTTP 200 and nothing in the tree noticed.
    find: "const handlers = {\n  'lrs.ingest_statement': async (args: Record<string, unknown>) =>",
    replace: "const handlers = {\n  'lrs.zz_mutant': async (_a: Record<string, unknown>) => ({ error: 'forbidden - admin only' }),\n  'lrs.ingest_statement': async (args: Record<string, unknown>) =>",
    mustFail: [VERTICAL_GATE],
    why: 'the gate titled "on every vertical" drove three of the eight that mount the dispatcher',
  },

  {
    name: 'untyped-decline-in-a-delegated-src-function',
    file: AC_SRC,
    // ★ NOT IN THE BRIDGE. `ac.author_tool` is a one-line delegator, so THIS function's return
    // value IS the HTTP response - and every census before the delegation leg read only
    // bridge/server.ts, which holds one return object literal in total.
    //
    // The cast keeps it compiling against the declared return type, and is not a way of
    // dodging the census: returnObjects unwraps as/satisfies/parens/angle-bracket assertions,
    // which is asserted in tests/return-object-scan.test.ts.
    find: "export async function authorTool(args: AuthorToolArgs, config: PublishConfig): Promise<AuthorToolResult> {",
    replace: "export async function authorTool(args: AuthorToolArgs, config: PublishConfig): Promise<AuthorToolResult> {\n  if (args.toolName === '__mutant') return { error: 'forbidden - admin only' } as unknown as AuthorToolResult;",
    mustFail: [VERTICAL_GATE],
    why: 'the answer is built in src/, and reading bridge/** reads the argument marshalling and none of the decisions',
  },

  {
    name: 'kernel-act-preresolved-retries-a-refusal',
    file: KERNEL,
    // ★★ act() reaches a target TWO ways and the first fix landed on one of them. The
    // descriptor leg delegates to followAffordance; a caller passing a PRE-RESOLVED target
    // took this leg, which had its own copy of the throw and read the body only after the
    // retry. Measured before the fix: 4 fetches, ~7s, and the refusal arrived as a THROWN
    // exception rather than as data.
    find: "      if (r.status >= 500 && !declaresRefusal(text)) {",
    replace: "      if (r.status >= 500 && !declaresRefusal('')) {",
    mustFail: [RETRY_GATE],
    why: 'a fix applied to one of two identical legs is not a fix to the class',
  },
  {
    name: 'retry-matcher-loses-the-reason-phrase-form',
    file: RETRY,
    // The third spelling has NO introducer: `forward POST 503 Service Unavailable`. Of the 23
    // in-repo 5xx throws inside a withTransientRetry callback, 22 matched the introducer form
    // and that one did not - so anchoring silently disabled retry for xAPI forwarding.
    find: "      || HTTP_5XX_WITH_REASON.test(message))) return true;",
    replace: "      || false)) return true;",
    mustFail: [RETRY_GATE],
    why: 'over-narrowing a matcher costs exactly what over-matching did, in the other direction',
  },

  {
    name: 'decline-note-key',
    file: AGP,
    // ★★ THE FOURTH SPELLING, PLANTED IN A DRIVEN VERTICAL ON PURPOSE.
    //
    // `note` is NOT in the census word list and deliberately never will be - adding it flags
    // nine successes that carry an advisory note. So the source census cannot catch this
    // mutant, and that is exactly what it is here to demonstrate: the leg that DRIVES agp
    // through the real dispatcher catches it anyway, because a driven leg asks what STATUS a
    // client sees and has no vocabulary to be out-spelled.
    find: "        return { ...refuse(400, 'Pass an inline `situation` object, or a `situation_iri` resolvable against `pod_url`. The engine ran nothing because no situation could be resolved.',\n          'no situation could be resolved from the arguments supplied'),\n          pending: 'situation-not-resolvable', tool: 'agp.diagnose', received: args };",
    replace: "        return { note: 'stub: pass an inline `situation` object, or a resolvable `situation_iri`.' };",
    mustFail: [VERTICAL_GATE],
    why: 'three foxxi handlers declined a required-input failure with `note` at HTTP 200; a word list has now lost four times',
  },

  {
    name: 'untyped-decline-behind-a-multi-statement-handler',
    file: FOXXI_SRC,
    // ★★ THE SHAPE THE DELEGATION CENSUS USED TO SKIP. `foxxi.upload_scorm_package` checks
    // authorization first and THEN returns uploadScormPackage(...) - two statements - and the
    // reach required a single-statement body, so this function and three others were never
    // followed. An audit found four untyped declines living in exactly that gap; verbatim the
    // pre-fix line here is one of them.
    find: "    return { ...refuse(400,\n      'Payload does not look like a zip file (no PK header).',\n      'the bytes supplied are not a zip archive, so no SCORM package could be read'), status: 'failed' };\n",
    replace: "    return { status: 'failed', error: 'Payload does not look like a zip file (no PK header).' };\n",
    mustFail: [VERTICAL_GATE],
    why: 'a rejected SCORM upload answered HTTP 200 with isError=false, so a caller was told a package it never accepted had been accepted',
  },

  // ── a published document nothing reads ─────────────────────────────
  {
    name: 'undeclared-owned-term-in-a-vertical-vocabulary',
    file: LPC_TTL,
    // The terms gate read docs/ns alone - 33 of the 46 published Turtle documents - so every
    // VERTICAL vocabulary was outside it, and `passport:Achievement` sat cited-as-a-superclass
    // and declared nowhere: byte-for-byte the class the gate's header boasts about catching.
    find: "    rdfs:subClassOf passport:Achievement ;",
    replace: "    rdfs:subClassOf passport:Achievement, passport:UndeclaredThing ;",
    mustFail: [TERMS_GATE],
    why: 'a consumer dereferencing the superclass lands on a document that never mentions it',
  },
  {
    name: 'namespace-declared-in-a-ttl-and-published-nowhere',
    file: ADP_SHAPES,
    // The namespace gate walked five directories of .ts, so a namespace declared in a .ttl was
    // invisible - which is how adp/shapes went unpublished while its sibling agp/shapes was
    // the very defect the gate had been written for.
    find: "@prefix adpsh: <https://markjspivey-xwisee.github.io/interego/applications/agent-development-practice/adp/shapes#> .",
    replace: `@prefix adpsh: <${UNPUBLISHED_NS}> .`,
    mustFail: [NS_GATE],
    why: 'every adpsh: shape IRI 404d at its own declared authority',
  },

  // ── a command, and a grant, that check nothing ─────────────────────────
  {
    name: 'status-advertises-an-empty-typecheck',
    file: STATUS_MD,
    // Verbatim what STATUS.md advertised: a tsc invocation whose program is EMPTY. It exits 0
    // having read nothing, and a maintainer running it before pushing reads that as a clean
    // repo. Measured: --listFilesOnly prints 0 lines for tsconfig.json, 1,514 for the real one.
    find: "- **`npx tsc --noEmit -p tsconfig.check.json`** \u2014 the repo-wide typecheck, 1,500+ files.",
    replace: "- **`npx tsc -p tsconfig.json --noEmit`** \u2014 the repo-wide typecheck, 1,500+ files.",
    mustFail: [ADVERTISED_GATE],
    why: 'the document that tells people how to check their work handed out a false green',
  },
  {
    name: 'a-pod-writer-slips-onto-the-read-side',
    file: RELAY,
    // ★★ record_trajectory_step's handler ends in handlePublishContext(…) with sign_authorship
    // defaulting true. Under the OLD hand-maintained WRITE_SIDE_TOOLS list it was simply absent
    // and therefore ungated; under default-deny the only way back in is to name it read-side,
    // which is what this plants. A bearer narrowed to mcp:read could publish a signed
    // descriptor - the read-only grant was not read-only.
    find: "  'analyze_question', 'interrogative_route', 'check_balance',",
    replace: "  'analyze_question', 'interrogative_route', 'check_balance', 'record_trajectory_step',",
    mustFail: [OAUTH_SCOPE_GATE],
    why: 'the old list missed nine mutating tools and named two that do not exist',
  },


  {
    name: 'an-advertised-privacy-mode-silently-degrades',
    file: LPC_IMPL,
    // ★★ Removing the only mention of the mode from the handler puts back exactly what an
    // audit found: `zk-distribution` matched no branch, fell into the v1 ABAC path, and the
    // caller who asked for the strongest advertised privacy over cohort data got an unblinded
    // exact count with no DP noise and no error.
    find: "  if (mode === 'zk-distribution') {",
    replace: "  if (mode === 'zzz-not-a-mode') {",
    mustFail: [PRIVACY_GATE],
    why: 'the published affordance is the only contract an aggregating institution has for what protection it is getting',
  },

  {
    name: 'a-caller-url-skips-the-egress-screen',
    file: RELAY,
    // Verbatim the pre-fix line. `resolve_webfinger` was the one of three named caller-URL
    // directory paths that kept solidFetch, which dials the global pool - and egress.ts is
    // explicit that the address screen attaches per-request, never globally.
    find: "  const result = await resolveWebFinger(args.resource as string, { fetch: guardedInvokeFetch });",
    replace: "  const result = await resolveWebFinger(args.resource as string, { fetch: solidFetch });",
    mustFail: [CALLER_URL_GATE],
    why: 'a census in a comment named all three and nothing re-checked that all three were done',
  },
  {
    name: 'the-singleton-write-loses-its-credential',
    file: RELAY,
    // `POST /tool/mint` ran with no credential at all while the READ of the same singleton was
    // gated for exactly the reason mint makes worse: it grows an in-process lattice with no
    // size cap, on a relay with an OOM history.
    find: "  'mint', 'promote',",
    replace: "  'promote',",
    mustFail: [CALLER_URL_GATE],
    why: 'the disclosure half of the shared-singleton problem was closed and the mutation half left open',
  },

  {
    name: 'a-runbook-tells-you-to-deploy-to-a-dead-platform',
    file: RUNBOOK,
    // ★★ Verbatim what spec/OPS-RUNBOOK.md said. `docs-drift-lint.mjs` had the rule that bans
    // it and scanned exactly README.md and STATUS.md - 2 of the 28 places the rule applied -
    // so 66 present-tense dead-Azure lines across 26 files sat outside it, 14 of them in this
    // runbook, describing the whole production fleet as Azure Container Apps with az-CLI
    // rollback and backup procedures. Railway was named in none of them.
    find: "   node tools/railway-redeploy.mjs <service> <40-hex-sha>",
    replace: "   bash deploy/azure-deploy.sh <component>",
    mustFail: [DRIFT_GATE],
    why: 'an operator following the runbook would run a script that provisions a deleted registry and repoints every service at it',
  },

  // ── the two legs written from the two live-found defects ────────────────────
  //
  // Running the four status mutants through the gate's five legs showed legs 3 and 4 were never
  // made to fail by ANY of them - so the two assertions covering the only two defects that file
  // was written from were as unverified as before the harness existed. Both legs select by
  // PHRASES in a refusal's message, which is the fragile half: reword a reason and the leg
  // silently selects nothing and passes over an empty set.
  {
    name: 'an-authenticated-non-member-is-told-401',
    file: FOXXI,
    // The defect itself, verbatim: the signature VERIFIED, so the caller is authenticated and
    // what they lack is membership. 401 sends an agent back to sign_request for credentials it
    // already holds, in a loop it cannot exit. Found by signing a real request against the live
    // bridge and reading the answer.
    find: "      return { kind: 'refusal' as const, 'iep:refusalStatus': 403,\n        'iep:resolvedBy': {\n          action: 'urn:iep:action:self-enroll',",
    replace: "      return { kind: 'refusal' as const, 'iep:refusalStatus': 401,\n        'iep:resolvedBy': {\n          action: 'urn:iep:action:self-enroll',",
    mustFail: [STATUS_GATE],
    why: 'leg 3 selects 39 refusal literals by phrase and no mutant ever flipped one',
  },
  {
    name: 'an-outage-is-reported-as-the-callers-fault',
    file: FOXXI,
    // The other live-found defect: the tenant directory could not be READ, which is our failure,
    // and 401 makes a real outage look like a permissions problem in every client log.
    find: "      'iep:refusalStatus': 503,\n      'iep:refusalReason': 'the tenant directory could not be read",
    replace: "      'iep:refusalStatus': 401,\n      'iep:refusalReason': 'the tenant directory could not be read",
    mustFail: [STATUS_GATE],
    why: 'leg 4 selects exactly one literal and nothing in the table flipped it',
  },

  {
    name: 'decline-in-a-vocabulary-no-word-list-anticipated',
    file: FOXXI,
    // ★★ THE ONLY MUTANT §B CATCHES AND §A DOES NOT, WHICH IS WHY IT EXISTS.
    //
    // Every other planted decline contains the word `forbidden`, the first alternative in §A's
    // DENIAL list - and §A is zero-tolerance, so it fails each of them on its own. Measured
    // through the gate's own predicates: all eight gave §A=1 alongside §B=1. The consequence,
    // also measured: raise UNTYPED_BUDGET from 0 to 1 and every one of them is still caught by
    // §A, so the harness printed a full pass with the ratchet one step looser. The ratchet's own
    // message says it "only holds while it is tight", and the harness could not see it slacken.
    //
    // This phrasing contains no word any list anticipated - which is the case §B was written
    // for, and the case that produced agp's `pending:` and foxxi's `note:` in production.
    find: '  const token = (args.__caller_token as string | undefined);',
    // `error:` is the KEY §B counts; the MESSAGE is what §A matches, and this one contains no
    // word any denial list anticipated. That asymmetry is the point: §A=0, §B=1.
    replace: "  if (args['__mutant']) return { error: 'this pod is sealed for the quarter' };\n  const token = (args.__caller_token as string | undefined);",
    mustFail: [REFUSAL_GATE],
    why: 'the untyped-return ratchet can be relaxed and every other mutant still passes, because all of them also trip the word list',
  },

  {
    name: 'a-readme-understates-its-own-surface',
    file: LPC_README,
    // The LPC bridge README said the vertical had 6 affordances. affordances.ts exports TWO
    // arrays - 7 learner-side and 4 institution-side - and the bridge concatenates them per
    // LPC_AUDIENCE, default `both`, so it mounts 11. Even the narrowest audience is 7. The
    // three sibling bridge READMEs all checked out, so this was one row going stale rather than
    // a convention nobody follows - the case a gate is for, and the case invisible without one.
    find: "After reload the vertical's tools are available. With the default `LPC_AUDIENCE=both` that is ",
    replace: "After reload, 6 tools available. With the default `LPC_AUDIENCE=both` that is ",
    mustFail: [README_COUNT_GATE],
    why: 'a README stating a smaller surface than the vertical declares is how a reader concludes a capability does not exist',
  },

  // ── the dispatcher itself, which no mutant touched ────────────────────────
  {
    name: 'the-dispatcher-stops-deriving-a-status',
    file: DISPATCHER,
    // ★★ EVERY HTTP-DRIVEN LEG OF THE REFUSAL GATES RAN THROUGH THIS LINE AND NOTHING PROVED
    // THEY WOULD NOTICE IT BREAKING. The mutants all planted defects in HANDLERS; the one
    // place that turns a declared refusal into a status code had no mutant at all - so the
    // legs that POST through createVerticalBridge and assert on the code were, as a group,
    // unverified. This is the original bug, restored: a refusal answering HTTP 200.
    //
    // An adversarial pass reported this gap and all three of its refuters rejected it. It was
    // right.
    find: "        const status = typeof declared === 'number'\n          ? declared\n          : KERNEL_RESULT_STATUS[kind] ?? 200;",
    replace: "        const status = 200;",
    mustFail: [VERTICAL_GATE, REFUSAL_GATE],
    why: 'the single line every driven leg depends on, and the defect this whole body of work began from',
  },

  {
    name: 'the-router-drops-contentBinding',
    file: ROUTER,
    // ★★ authorshipVerified answers WHO SIGNED; contentBinding answers WHETHER THAT SIGNATURE
    // COVERS THE GRAPH. get_descriptor's own description says a proof can verify while covering
    // nothing, and `unbound` is what every pre-content-binding proof still reports. Projecting
    // one without the other hands a reader a verified-looking answer over unattested content.
    find: "        contentBinding: authorship?.contentBinding,",
    replace: "        contentBinding: undefined,",
    mustFail: [ROUTER_GATE],
    why: 'reported by an adversarial pass and rejected by all three of its refuters; it was right',
  },

  {
    name: 'a-turtle-writer-loses-its-iri-screen',
    file: SEALER,
    // ★★ `mirrorTurtleFor` wrote `<${graphIri}>` as the subject of every triple with NO screen.
    // The gate titled "every interpolated IRI is refused rather than escaped" drove eight of
    // this package's twelve Turtle writers and this was one of the four it skipped - so the one
    // writer that actually had the defect was the one nothing drove.
    find: "  if (UNSERIALIZABLE.test(graphIri)) {",
    replace: "  if (false && UNSERIALIZABLE.test(graphIri)) {",
    mustFail: [INJECTION_GATE],
    why: 'an IRI reference ends at the first > and Turtle has no escape, so a caller-supplied graph IRI could write the rest of the line',
  },

  {
    name: 'a-retry-is-nested-inside-a-retry-again',
    file: OAUTH_STORE,
    // ★★ Verbatim the wrap that was removed. `discover` retries its own manifest GET at
    // {maxAttempts: 6, baseMs: 500} and the inner throw is accepted by the matcher at both
    // layers, so this multiplied the documented ceiling. Measured on the sibling call:
    // 16 HTTP requests over 35.5s for ONE durable 503, in a path that runs at startup for
    // every registered OAuth client.
    find: "    entries = await discover(cfg.podUrl, undefined, { fetch: cfg.fetch });",
    replace: "    entries = await withTransientRetry(() => discover(cfg.podUrl, undefined, { fetch: cfg.fetch }));",
    mustFail: [NESTED_RETRY_GATE],
    why: 'the amplification that had previously left the OAuth client directory empty after every restart',
  },
  {
    name: 'a-tracked-extension-loses-its-text-attribute',
    file: GITATTRIBUTES,
    // 201 tracked .srl files - the SHACL suite's result fixtures. Undeclared, they carry
    // `diff: unspecified`, and a control byte in one is invisible in review, which is the
    // undiffable state .gitattributes exists to prevent. Nine extensions were in that state.
    find: "*.srl    text eol=lf diff\n",
    replace: "",
    mustFail: [BYTES_GATE],
    why: 'the byte gate said the two files stay in agreement and nothing compared them',
  },
  {
    name: 'a-screened-writer-goes-back-to-raw-interpolation',
    file: 'applications/shared-workspace/src/stream.ts',
    // The exact shape the injection ratchet exists to stop returning: two IRIs that reach
    // `entryTurtle` from a caller, written straight into the subject and object positions.
    // `turtleIriRef` returns null for a value holding the characters that end an IRI reference,
    // and a reference ends at the first `>` with no escape available - so this is not cosmetic.
    find: "  const subject = turtleIriRef(args.entryIri);\n  const workspace = turtleIriRef(args.workspace);",
    replace: "  const subject = `<${args.entryIri}>`;\n  const workspace = `<${args.workspace}>`;",
    mustFail: [IRI_RATCHET_GATE],
    why: 'the population of raw interpolations must not be able to grow back while the real ones are being fixed',
  },
  {
    name: 'the-injection-ratchet-counts-prose-again',
    file: IRI_RATCHET_GATE,
    // ★★ The ratchet's own defect, twice over. Counting the pattern across the whole file made a
    // COMMENT explaining the rule a breach of it - and, worse, made part of the allowance payable
    // in deleted comments, so a new caller-reachable site could be added at a flat total. This
    // mutant restores that whole-file match; the gate below is what noticed, and the leg that
    // catches it is the one asserting a mention in a comment counts zero.
    // ★ ANCHORED ON THE SIGNATURE, NOT THE BODY, AND THAT IS A CORRECTION. The first version of
    // this mutant quoted the whole function. Adding the parse-failure guard to it made the anchor
    // stale, and CI reported "the table is stale, so the gate it verifies is unchecked" — which is
    // the harness working, and also a mutant that quotes prose it does not depend on. One line
    // that cannot drift, and an early `return` restores the whole-file match exactly.
    find: "export function countSitesIn(text, fileName = 'file.ts') {",
    replace: "export function countSitesIn(text, fileName = 'file.ts') {\n"
      + "  return (text.match(RAW_IRI) ?? []).length;",
    mustFail: [IRI_COUNTER_GATE],
    why: 'a gate that cannot be documented in the files it governs, whose allowance was part prose',
  },
  {
    name: 'an-advertised-input-is-accepted-and-dropped',
    file: 'applications/agentic-performance-practice/bridge/handlers.ts',
    // ★★ Verbatim the state `agp.actualize` was in: `success` and `score_scaled` declared in the
    // affordance, accepted by the handler, and absent from the published triples, with HTTP 200
    // telling the caller the outcome had been recorded. The first attempt to close it changed the
    // input DESCRIPTIONS to say so - honest record, same lost data.
    find: "            // The observed outcome, when the caller observed one. Nothing is emitted otherwise.\n            ...agpOutcomeProperties(success, scoreScaled),\n",
    replace: "",
    mustFail: [ACCEPTED_INPUT_GATE],
    why: 'an input a capability advertises must reach the graph or be refused; silently dropping it reports success for work not done',
  },
  {
    name: 'an-out-of-range-score-is-clamped-instead-of-refused',
    file: 'applications/agentic-performance-practice/bridge/handlers.ts',
    // A clamp is the plausible-looking alternative to a refusal, and it publishes a measurement
    // nobody took: 1.5 becomes a recorded 1.0, which reads downstream as a perfect outcome.
    find: "        if (!Number.isFinite(n) || n < -1 || n > 1) {",
    replace: "        if (false) {",
    mustFail: [ACCEPTED_INPUT_GATE],
    why: 'a refusal is a decision; clamping a caller\'s number into range publishes a measurement nobody took',
  },
  {
    name: 'an-untyped-decline-two-hops-down',
    file: 'applications/organizational-working-memory/src/pod-publisher.ts',
    // ★★ THE HOP THE CENSUS COULD NOT SEE. `owm.upsert_person` tail-calls `upsertPerson`, which
    // tail-calls `publishOwm` - so publishOwm's return value IS the HTTP response, and the census
    // stopped one function short of it. Five owm handlers reach here. A decline planted at this
    // depth was invisible while the walk was depth-one, and the bound was written in a comment
    // rather than closed.
    find: "  const now = nowIso();\n  const descId = `urn:iep:owm:desc:",
    replace: "  if (args.confidence === 0.4242) return { error: 'forbidden — org policy denied this write' };\n"
      + "  const now = nowIso();\n  const descId = `urn:iep:owm:desc:",
    mustFail: [VERTICAL_GATE],
    why: 'a decline built deeper than one hop and passed up unchanged answered 200 and no census saw it',
  },
  {
    name: 'a-scope-is-declared-and-never-read',
    file: 'applications/agent-collective/src/pod-publisher.ts',
    // ★★ Verbatim the state the apply loop was in: every discovered PromotionConstraint enforced
    // against every promotion, while `ieh:appliesToToolType` sat declared, written by two demos,
    // and bound by nothing. The ontology recorded it as "DECLARED BUT UNREAD", which made the
    // vocabulary honest and left a rule scoped to one tool type governing all of them.
    find: "        appliesToToolType: readIriValue(subj, APPLIES_TO_TOOL_TYPE),",
    replace: "        appliesToToolType: undefined,",
    mustFail: [SCOPED_CONSTRAINT_GATE],
    why: 'a scoping rule that does not scope is worse than an absent one: the publisher who sets it believes their constraint is narrow',
  },
  {
    name: 'an-undetermined-scope-is-skipped-instead-of-refused',
    file: 'applications/agent-collective/src/pod-publisher.ts',
    // The inverted defect, and the one a fix for the above naturally introduces: treating "this
    // promotion declares no type" as "the scoped constraint does not apply" makes every scoped
    // governance rule escapable by omitting one argument.
    find: "        if (declaredTypes.length === 0) {",
    replace: "        if (false) {",
    mustFail: [SCOPED_CONSTRAINT_GATE],
    why: 'a governance rule that can be evaded by leaving a field out is not enforced',
  },
  {
    name: 'one-iri-declared-as-two-kinds-of-thing',
    file: 'docs/ns/iep.ttl',
    // ★★ Verbatim the collision found in the published ontology: iep:podUrl declared
    // owl:ObjectProperty in the affordance section and owl:DatatypeProperty beside the
    // notification terms. No OWL DL reasoner accepts it, and BOTH serializations are actually
    // written - the directory emits an IRI node, a notification frame a typed literal - so a
    // reader could not tell which to expect. Two more terms were declared twice, one of them
    // (ieh:AgentMemory) as two entirely different classes.
    find: "iep:affordance a owl:ObjectProperty ;",
    replace: "iep:podUrl a owl:ObjectProperty ;\n    rdfs:label \"pod URL\" ;\n    rdfs:isDefinedBy <https://markjspivey-xwisee.github.io/interego/ns/iep#>.\n\niep:affordance a owl:ObjectProperty ;",
    mustFail: [DUPLICATE_TERM_GATE],
    why: 'a term declared twice is where a range or a comment drifts from its twin, and where two concepts end up sharing one IRI',
  },
  {
    name: 'nested-conformance-counts-only-violations',
    file: 'packages/core/src/validation/shacl-engine.ts',
    // ★★★ Verbatim the rule the nested evaluator used. §3.6: conforms is true "if the validation
    // did not produce any validation results" - ANY result, at ANY severity. The top-level driver
    // was corrected to that and `conformsToShapeInner` was not, so an inner failure at sh:Info or
    // sh:Warning read as CONFORMANCE and the outer sh:node never fired. Worse under sh:not, where
    // it inverts: a rule its author softened to advice became a hard rejection one level up. The
    // same function was already inconsistent with itself, checking nodeLevelShape three lines
    // above with `.length > 0`.
    // ★ RE-ANCHORED. This quoted `.length > 0`, which was the FIRST fix and itself an overshoot —
    // it counted sh:Debug, sh:Trace and engine advisories that the top-level rule excludes. Both
    // readings come from `countsAsNonConformance` now, so the mutant reverts THAT, which is the
    // reading the §3.6 hole actually consisted of.
    find: "  for (const ps of target.propertyShapes) {\n    if (evaluatePropertyShape(data, subj, target, ps, byId, depth + 1, subclassClosure)\n      .some(countsAsNonConformance)) return false;\n  }",
    replace: "  for (const ps of target.propertyShapes) {\n    if (evaluatePropertyShape(data, subj, target, ps, byId, depth + 1, subclassClosure)\n      .some(r => r.severity === 'Violation')) return false;\n  }",
    mustFail: [SEVERITY_GATE],
    why: 'a severity is how loudly a result speaks, not whether it counts - and one level down it decided whether the result existed at all',
  },
  {
    name: 'a-notification-context-that-defines-nothing',
    file: 'deploy/mcp-relay/notification-event.ts',
    // ★★ Verbatim what the relay emitted: the Turtle NAMESPACE IRI in place of the published
    // JSON-LD context document. A namespace defines no terms, so every key expanded to nothing,
    // `timestamp`/`author` did not reach dct:created/prov:wasAttributedTo, and the frame became an
    // anonymous untyped node — which CONFORMS to a NodeShape vacuously, which is why the mismatch
    // survived in the published ontology as a paragraph of prose instead of a failing gate.
    find: "  'https://markjspivey-xwisee.github.io/interego/ns/iep/v1.json';",
    replace: "  'https://markjspivey-xwisee.github.io/interego/ns/iep#';",
    mustFail: [NOTIFICATION_FRAME_GATE],
    why: 'a frame that names a shape it does not instantiate, where the failure mode is a vacuous pass rather than an error',
  },
  {
    name: 'a-census-reads-its-own-comments-again',
    file: 'tests/return-object-scan.ts',
    // ★★ The false-POSITIVE half of the same class. Every caller matches decline words against
    // this text, so a comment inside a return object put prose into the evidence: one annotated
    // "for the same reason:" was reported as an untyped refusal on a handler that declines
    // nothing. The privacy-mode gate had the mirror-image bug - a comment naming a mode SATISFIED
    // it after the branch was deleted. Both are fixed by asking the parser, not the text.
    find: "      text: textWithoutComments(obj, sf),",
    replace: "      text: obj.getText(sf),",
    mustFail: [VERTICAL_GATE],
    why: 'a gate that reads its own explanatory prose as evidence fails on correct code, and a gate that always fails is a gate nobody reads',
  },
];
