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
    mustFail: [BYTES_GATE],
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
];
