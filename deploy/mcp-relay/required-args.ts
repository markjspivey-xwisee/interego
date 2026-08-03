/**
 * The arguments a tool cannot be called without — and cannot be called with the wrong
 * TYPE of — refused at the door.
 *
 * ── WHY THIS EXISTS AS ITS OWN MODULE ────────────────────────────────────────
 *
 * `tools/call` performs NO schema validation. Every tool's `inputSchema` carries a
 * `required` array and a `type` for each property, four transports dispatch through it,
 * and not one of them looks at either. So the schema is documentation that reads like a
 * guard, and the guard is whatever the handler happens to do when it dereferences an
 * argument that is not there — or that is there and is the wrong shape.
 *
 * Measured, not assumed — every tool called with `{}` against a running relay:
 *
 *     publish_context   → {"published": true, "status": "pending"}, then, in the
 *                         deferred write, `TypeError: The "string" argument must be of
 *                         type string … Received undefined`
 *     compose           → SUCCEEDS. An absent `operator` falls through union and
 *                         intersection into the `else` branch of kernel compose(), which
 *                         is OVERRIDE — the operator where later operands win. The result
 *                         reports `operator: undefined` and the composition already happened.
 *     add_pod           → {"added": true} — `undefined` is now a key in the federation
 *                         registry, and it was persisted.
 *     remove_pod        → {"removed": true} — about a pod the call never named.
 *     unsubscribe_from_pod → {"unsubscribed": false, "message": "No active subscription
 *                         on undefined."}
 *     pgsl_meet         → {"meet": null, "message": "No shared sub-fragment between
 *                         undefined and undefined"} — a negative finding about two graphs
 *                         nobody named.
 *     mint              → a content address. For nothing.
 *     decompose         → {"result": null} — reads as "that IRI has no decomposition".
 *     restrict          → TypeError: Cannot read properties of undefined (reading 'kind')
 *     discover_context  → TypeError: Cannot read properties of undefined (reading 'endsWith')
 *     get_descriptor    → TypeError: Cannot read properties of undefined (reading 'endsWith')
 *     analyze_question  → TypeError: Cannot read properties of undefined (reading 'toLowerCase')
 *     pgsl_resolve      → TypeError: Cannot read properties of undefined (reading 'startsWith')
 *     pgsl_ingest       → TypeError: The "string" argument must be of type string …
 *     resolve_webfinger → TypeError: Cannot read properties of undefined (reading 'startsWith')
 *     subscribe_to_pod  → TypeError: The "data" argument must be of type string …
 *     discover_directory→ invoke: unparseable URL: undefined
 *
 * Two failure shapes, both of which this module exists to replace with one sentence:
 *
 *   - a Node TypeError naming an INTERNAL property (`'endsWith'`, `'kind'`) and no
 *     argument, so the caller cannot tell which of its arguments was wrong; and
 *   - a SUCCESSFUL-LOOKING ANSWER computed over a value nobody sent, which is worse,
 *     because there is nothing in it to notice.
 *
 * `publish_context` is both at once, which is what put this on the list: the caller is
 * told `published: true` and the refusal arrives later, on a background task, as a type
 * error naming no argument.
 *
 * ── WHY PRESENCE IS NOT ENOUGH, AND THE TYPE IS CHECKED TOO ──────────────────
 *
 * ★ The first version of this module tested presence only — `undefined | null | ''`. A
 * number, an array, an object or a boolean was "present", so it went through, and the
 * whole list above came back UNCHANGED for those values. Re-measured against the
 * presence-only gate, every one of the 19 tools below passed with all of its required
 * arguments set to `42`, and `publish_context` reproduced the quoted defect character for
 * character:
 *
 *     graph_content: 42    → {"published": true}, then TypeError: The "string" argument
 *                            must be of type string … Received type number (42)
 *     graph_content: []    → … Received an instance of Array
 *     graph_content: {}    → … Received an instance of Object
 *
 * ★ AND FOR `graph_iri` IT IS WORSE THAN A TypeError: THE PUBLISH SUCCEEDS.
 *
 * `ContextDescriptor…describes(x)` does not throw on a non-IRI, it SERIALIZES it. Measured
 * end-to-end through the real `publish()`:
 *
 *     graph_iri: {}                            → iep:describes <[object%20Object]>
 *     graph_iri: []                            → iep:describes <>   (the descriptor's own URL)
 *     graph_iri: ["urn:graph:a","urn:graph:b"] → iep:describes <urn:graph:a,urn:graph:b>
 *     graph_iri: {"@id":"urn:graph:x"}         → iep:describes <[object%20Object]>
 *
 * Those bytes commit to the pod, are content-addressed, and on the compliance path are
 * pinned to IPFS. `{"@id": …}` and `["urn:graph:x"]` are exactly what a JSON-LD-minded
 * connector or an LLM emits for a field named `graph_iri`. Worse still, the collision gate
 * downstream narrows a non-string to `undefined` — so it is told "this publish names no
 * graph" while the bytes on the pod claim to describe a fabricated one.
 *
 * ★ AND `compose` PROVES PRESENCE-ONLY IS THE WRONG QUESTION. Its silent-OVERRIDE defect
 * is a VALUE problem, not an absence problem. Measured against kernel compose():
 *
 *     "override" → composed.id = urn:iep:composed:c208cee…  reported operator "override"
 *     "unoin"    → composed.id = urn:iep:composed:c208cee…  reported operator "unoin"
 *     42         → composed.id = urn:iep:composed:c208cee…  reported operator 42
 *
 * Byte-identical to OVERRIDE, echoing the caller's typo back as if it had been honoured.
 * Gating `operator` for absence alone left the likelier client bug — a misspelling of a
 * field the schema advertises as required — doing exactly what it did before.
 *
 * The sibling refusal module written one increment earlier already checks the type:
 * `supersession-frontier.ts:143` is `typeof graphIri !== 'string' || …`. The same argument,
 * in the same handler, was refused by one gate and waved through by the other.
 *
 * ── WHY IT IS A SIBLING MODULE AND NOT AN INLINE `if` ────────────────────────
 *
 * Same reason `casRefusal` is one: `server.ts` starts an HTTP listener on import, so a
 * refusal written inline there is a branch no unit test can reach. Every hole closed in
 * `supersession-frontier.ts` was "the branch that quietly did not run", and a guard whose
 * only witness is the code it guards repeats that shape. The wire answer lives here so a
 * test can assert on the wire answer.
 *
 * ── WHY `retryable` IS FALSE AND THE CODE IS 400 ─────────────────────────────
 *
 * No number of retries supplies an argument the caller did not send, and none turns a
 * number into an IRI. This relay has already shipped one refusal that said `503 …
 * retryable: true` for an `if_match` value that could never work, and a client that
 * believes `retryable` loops until it gives up — on its own compare-and-swap. A missing or
 * mistyped argument is the same category and gets the same answer as `casRefusal`'s 400s:
 * this request cannot succeed; change it, don't resend it.
 */

/**
 * What an enforced argument must BE, in the vocabulary of the tool's own `inputSchema`.
 *
 * `'any'` is a real answer, not a placeholder — see `mint.content` below.
 */
export type ArgKind = 'string' | 'array' | 'object' | 'any';

/** One enforced argument: its name, the type its schema declares, and any closed vocabulary. */
export interface RequiredArg {
  readonly name: string;
  readonly kind: ArgKind;
  /**
   * The complete set of values this argument may take, when its schema declares an `enum`.
   * Only meaningful with `kind: 'string'`. Present for exactly one argument today —
   * `compose.operator` — because an out-of-vocabulary value there is silently honoured as
   * OVERRIDE rather than refused.
   */
  readonly values?: readonly string[];
}

/** An argument that was supplied, but not as anything the tool can use. */
export interface InvalidArg {
  readonly name: string;
  /** What the schema says it must be — `'a string'`, or `'one of: union, …'`. */
  readonly expected: string;
  /** What arrived, described so the caller can recognise its own value in it. */
  readonly received: string;
}

/**
 * The refusal envelope, field-for-field the shape `casRefusal` returns, plus the two lists.
 *
 * `message` names the arguments in prose because a human or an LLM reads that; `missing`
 * and `invalid` carry the same facts machine-readably so a caller does not have to parse
 * English to find out which argument to fix.
 *
 * ★ `error` IS DERIVED, AND THE RULE IS "ABSENCE WINS". A call can be both incomplete and
 * mistyped; a slug can only say one thing. It says `missing_required_argument` whenever
 * anything is absent, because that is the more fundamental fault and it is what the slug
 * already meant to every client that shipped against it. A machine reader that wants the
 * whole truth reads `missing` and `invalid`, which are BOTH always present — the slug is a
 * summary, and it is documented here as one rather than being quietly load-bearing.
 */
export interface RequiredArgsRefusal {
  readonly error: 'missing_required_argument' | 'invalid_required_argument';
  readonly code: number;
  readonly retryable: boolean;
  readonly message: string;
  readonly missing: readonly string[];
  readonly invalid: readonly InvalidArg[];
}

/**
 * Tool → the arguments this relay REFUSES to run without, and what each must be.
 *
 * ★ THIS IS DELIBERATELY NOT "every `required` field in every inputSchema".
 *
 * 34 tools declare `required`; this table lists 19. The others were measured too and left
 * alone, because they already answer the caller immediately and in words:
 *
 *   remember, record_trajectory_step, notify_agent, render_hmd, publish_node,
 *   get_current_head, reduce_chain, interrogative_route, invoke_affordance
 *       — already return a named refusal ("`body` is required (the note text)").
 *   promote
 *       — throws `promote() requires at least one atom` on the request thread. Readable,
 *         immediate, and it names the thing. A second guard in front of it would only
 *         change the wording.
 *   verify_agent, register_agent, revoke_agent
 *       — `agent_id` is server-injected from the auth context before the handler runs, so
 *         "absent" here means an unauthenticated caller, and each already refuses on that
 *         ground with a better message than a missing-argument one would be.
 *   set_reachability
 *       — an absent `channels` currently means "clear my channels", which is a real
 *         operation. Refusing it would change behaviour, not repair it. See the report.
 *   link_wallet, setup_identity
 *       — stubs on the remote relay; they return a fixed explanatory envelope.
 *
 * Adding a tool here is a behaviour change for that tool: a call that used to reach the
 * handler stops reaching it. That is why the list is enumerated rather than derived —
 * deriving it from the schemas would silently gate the nine tools above the next time
 * someone added a `required` field, and the blast radius would grow without anyone
 * choosing it.
 *
 * ★ THE `kind` OF EACH ARGUMENT IS COPIED FROM THAT TOOL'S OWN PUBLISHED `inputSchema`,
 * NOT INVENTED HERE. `required-args.test.ts` re-reads every one of them out of `server.ts`
 * and fails if this table and the schema disagree — so the gate can never start demanding
 * a type the tool never advertised, which would be a refusal no reader of `tools/list`
 * could have predicted.
 */
export const ENFORCED_REQUIRED_ARGS: Readonly<Record<string, readonly RequiredArg[]>> = {
  // The one that reported success and failed afterwards — and, for `graph_iri`, the one
  // that reported success and then WROTE a fabricated IRI to the pod.
  publish_context: [
    { name: 'graph_iri', kind: 'string' },
    { name: 'graph_content', kind: 'string' },
  ],
  // ★ `mint.content` is 'any' ON PURPOSE, and it is the reason `ArgKind` has an 'any'.
  // Its schema declares NO type — "Value (atom), list (fragment), descriptor JSON, or any
  // value (opaque)" — because mint is content-addressed over whatever it is handed. A
  // string check here would refuse the fragment and descriptor kinds the tool exists to
  // serve. Presence is genuinely the whole of what can be checked for this one.
  mint: [{ name: 'content', kind: 'any' }],
  dereference: [{ name: 'iri', kind: 'string' }],
  // `operator` above all: absent, it silently performs an OVERRIDE — and so does any value
  // outside the vocabulary, which is why this is the one entry carrying `values`.
  compose: [
    { name: 'descriptors', kind: 'array' },
    { name: 'operator', kind: 'string', values: ['union', 'intersection', 'restriction', 'override'] },
  ],
  restrict: [
    { name: 'descriptor', kind: 'object' },
    { name: 'selector', kind: 'object' },
  ],
  extend: [
    { name: 'part', kind: 'object' },
    { name: 'whole', kind: 'object' },
  ],
  decompose: [{ name: 'iri', kind: 'string' }],
  // Pod / federation reads and control-plane mutators.
  discover_context: [{ name: 'pod_url', kind: 'string' }],
  get_descriptor: [{ name: 'url', kind: 'string' }],
  subscribe_to_pod: [{ name: 'pod_url', kind: 'string' }],
  unsubscribe_from_pod: [{ name: 'pod_url', kind: 'string' }],
  add_pod: [{ name: 'pod_url', kind: 'string' }],
  remove_pod: [{ name: 'pod_url', kind: 'string' }],
  discover_directory: [{ name: 'directory_url', kind: 'string' }],
  resolve_webfinger: [{ name: 'resource', kind: 'string' }],
  // Comprehension + lattice.
  analyze_question: [{ name: 'question', kind: 'string' }],
  pgsl_ingest: [{ name: 'content', kind: 'string' }],
  pgsl_resolve: [{ name: 'uri', kind: 'string' }],
  pgsl_meet: [
    { name: 'uri_a', kind: 'string' },
    { name: 'uri_b', kind: 'string' },
  ],
};

/**
 * Was this argument supplied at all?
 *
 * ★ THE TEST IS "NOT SUPPLIED", NOT "FALSY", AND NOT "EMPTY".
 *
 * `undefined` and `null` are both "you did not send this" — JSON has no `undefined`, so a
 * client that means "absent" over the wire sends `null`, and `null` reaches every one of
 * the handlers above exactly as `undefined` does (`publish()` throws the same TypeError on
 * either). A string that is only whitespace is the same claim: it is not an IRI, not a
 * question, and not Turtle, and `' '.endsWith(…)` fails no differently.
 *
 * What is deliberately NOT absent:
 *
 *   - `[]` — an empty array is a value. `compose{descriptors: []}` already answers
 *     "compose() requires at least one descriptor" in words, and calling `[]` "absent"
 *     would let this module start refusing calls it was never asked to judge. It is a
 *     well-typed `array`, so it passes the type check below too.
 *   - `0` and `false` on a `kind: 'any'` argument — `mint` is content-addressed over
 *     whatever it is handed, and `0` is a thing to mint.
 *
 * The distinction matters because the whole point is to say something TRUE about the
 * request. "You did not send graph_content" must not be the answer to a caller who sent
 * an empty graph on purpose — nor to one who sent a number, who gets told about the
 * number instead.
 */
function isAbsent(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && value.trim().length === 0;
}

/**
 * Describe what arrived, in words the caller can match against what they sent.
 *
 * Scalars are quoted with their value because "you sent 42" is actionable and "you sent a
 * number" is a riddle. Arrays and objects are named by kind only: the offending value is
 * frequently a whole graph payload, and echoing it back would put the caller's own body
 * inside an error string.
 */
function describeValue(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return JSON.stringify(value);
    case 'number': case 'boolean': case 'bigint': return `${typeof value} (${String(value)})`;
    case 'object': return 'an object';
    default: return typeof value;
  }
}

/** Does `value` satisfy `spec`? Only called for values that are present. */
function satisfies(value: unknown, spec: RequiredArg): boolean {
  switch (spec.kind) {
    case 'any': return true;
    case 'array': return Array.isArray(value);
    // `null` is already absent, and an array is not the `object` any of these handlers
    // mean — `restrict` reads `selector.kind`, which is `undefined` on an array.
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'string':
      if (typeof value !== 'string') return false;
      return spec.values ? spec.values.includes(value) : true;
  }
}

/** Which of `tool`'s enforced arguments this call did not supply, in schema order. */
export function missingRequiredArgs(tool: string, args: Record<string, unknown>): readonly string[] {
  return (ENFORCED_REQUIRED_ARGS[tool] ?? [])
    .filter(spec => isAbsent(args[spec.name]))
    .map(spec => spec.name);
}

/**
 * Which of `tool`'s enforced arguments were supplied as something the tool cannot use.
 *
 * Disjoint from `missingRequiredArgs` by construction: an absent value is reported as
 * absent and never also as invalid, so the two lists never name the same argument and a
 * caller reading both is never told two different stories about one field.
 */
export function invalidRequiredArgs(tool: string, args: Record<string, unknown>): readonly InvalidArg[] {
  const out: InvalidArg[] = [];
  for (const spec of ENFORCED_REQUIRED_ARGS[tool] ?? []) {
    const value = args[spec.name];
    if (isAbsent(value) || satisfies(value, spec)) continue;
    out.push({
      name: spec.name,
      expected: spec.values ? `one of: ${spec.values.join(', ')}` : `a ${spec.kind}`,
      received: describeValue(value),
    });
  }
  return out;
}

/**
 * The refusal for a call that omitted or mistyped a required argument — or `null` to proceed.
 *
 * ★ Returns the refusal rather than throwing it. A throw becomes
 * `{ isError: true, text: "Error: …" }` at the dispatch shell, which is the shape every
 * opaque TypeError above already arrives in — indistinguishable, to a caller, from the
 * relay falling over. A returned envelope is the same JSON object shape every other
 * relay refusal uses, so a client that already reads `error`/`code`/`retryable` needs no
 * new case.
 */
export function requiredArgsRefusal(
  tool: string,
  args: Record<string, unknown>,
): RequiredArgsRefusal | null {
  const missing = missingRequiredArgs(tool, args);
  const invalid = invalidRequiredArgs(tool, args);
  if (missing.length === 0 && invalid.length === 0) return null;

  const all = (ENFORCED_REQUIRED_ARGS[tool] ?? []).map(s => `\`${s.name}\``).join(', ');
  // Each clause states only what is true of THIS call. A call that sent `graph_iri: 42`
  // must not be told it "was called without graph_iri" — that is a false sentence about
  // the request, and a false explanation is the thing this whole module is against.
  const clauses: string[] = [];
  if (missing.length > 0) {
    clauses.push(`was called without ${missing.map(m => `\`${m}\``).join(' and ')}`);
  }
  for (const bad of invalid) {
    clauses.push(`was called with \`${bad.name}\` as ${bad.received}, which must be ${bad.expected}`);
  }

  return {
    error: missing.length > 0 ? 'missing_required_argument' : 'invalid_required_argument',
    code: 400,
    retryable: false,
    missing,
    invalid,
    message:
      `${tool} ${clauses.join('; it ')}. `
      + `It requires ${all}. `
      + 'Refused here rather than passed on: these arguments are dereferenced deep inside '
      + 'the call, where a wrong or absent value surfaces as an internal type error naming '
      + 'no argument — or, worse, as an answer computed over a value you never sent, or a '
      + 'document written to a pod claiming an IRI you never named. Resending will not '
      + 'help; fix the argument.',
  };
}
