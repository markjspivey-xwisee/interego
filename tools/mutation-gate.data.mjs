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
const RETRY = 'packages/core/src/http/retry.ts';
const FOLLOW = 'packages/core/src/affordance/follow.ts';
const HYPER = 'packages/core/src/kernel/hypermedia.ts';
const KERNEL = 'packages/core/src/kernel/index.ts';

const REFUSAL_GATE = 'tests/a-refusal-answers-a-refusing-status.test.ts';
const STATUS_GATE = 'tests/a-refusal-status-names-what-actually-failed.test.ts';
const VERTICAL_GATE = 'tests/every-vertical-declines-with-a-status.test.ts';
const RETRY_GATE = 'tests/a-refusal-is-never-retried-as-a-blip.test.ts';
const BYTES_GATE = 'tests/line-endings-are-normalised.test.ts';

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
    why: 'an expression-bodied handler `=> ({…})`; 23 handler entries use that form',
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
    why: 'the six status helpers stand behind 26 call sites and were selected by no leg',
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
];
