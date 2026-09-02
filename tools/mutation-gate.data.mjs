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

const REFUSAL_GATE = 'tests/a-refusal-answers-a-refusing-status.test.ts';
const STATUS_GATE = 'tests/a-refusal-status-names-what-actually-failed.test.ts';
const VERTICAL_GATE = 'tests/every-vertical-declines-with-a-status.test.ts';

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
];
