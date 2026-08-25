/**
 * The caller-supplied identifiers this relay writes inside Turtle IRI brackets — refused
 * at the door when they cannot BE an IRI reference, and handed back ALREADY SERIALIZED so
 * there is no second, unchecked path from the argument to the document.
 *
 * ── ★★ WHY THE ONLY CORRECT HANDLING IS A REFUSAL ────────────────────────────
 *
 * Turtle's IRIREF production forbids `<` `>` `"` `{` `}` `|` `^` backtick `\`, space, and
 * every codepoint below 0x21 — and defines NO escape for any of them. An IRI reference
 * ends at the first `>`. So a value like
 *
 *     urn:x> ; prov:wasAttributedTo <did:someone-else
 *
 * closes the IRI, opens a new predicate, and writes a triple the caller was never
 * authorised to assert. There is nothing to escape it TO; `turtleIriRef()` returns null
 * rather than guessing, and this module is what the relay does with that null.
 *
 * ── ★★ IT IS A DELIMITER GATE, NOT AN ABSOLUTE-IRI GATE, AND THAT DISTINCTION ─
 * ──    WAS AN OUTAGE ────────────────────────────────────────────────────────
 *
 * `turtleIriRef()` refuses TWO different things at once: a value carrying a character
 * IRIREF forbids (an injection), and a value with no scheme (a resolution question — a
 * relative reference resolves against whatever base the reading parser happens to use).
 * The first shipped here as the second, and refused the relay's OWN identity.
 *
 * MEASURED on the real relay, driven over `POST /tool/remember` with a valid
 * identity-server bearer: EVERY call refused, `unusable_iri_argument`, `retryable:false`.
 * `verifyBearerToken` returns the identity server's `agentId` verbatim, and that value is
 * a BARE SLUG by construction — `mcp-client-<userId>`, `<surface>-<userId>`,
 * `wallet-<address>` (deploy/identity/server.ts). `injectRestVerifiedIdentity` then
 * injects it as `agent_id`, so the gate was rejecting a field the caller never sent and
 * could not fix, in a message that blamed the caller for sending it. `remember` and
 * `record_trajectory_step` were dead on both REST transports; `/mcp` escaped only because
 * `canonicalSurfaceAgentDid` had already turned the same slug into a `did:web:`.
 *
 * ★ SO THE RULE HERE IS THE INJECTION HALF ONLY: refuse a value that cannot be WRITTEN
 * inside `<…>`, accept one that can. `urn:x> ; prov:wasAttributedTo <did:someone-else` is
 * still refused — it carries `>`, `<` and spaces. `mcp-client-u-pk-test` is written, which
 * is exactly what the relay wrote before this module existed. Requiring a scheme would be
 * a separate and larger change: it would rewrite the identity that lands in
 * `prov:wasAttributedTo` on two live transports, and this gate is not the place to decide
 * that. See `turtleIriToken` below for how the character list is consulted without being
 * copied.
 *
 * ── ★ WHY THE VALIDATED FORM IS RETURNED, NOT JUST A VERDICT ─────────────────
 *
 * A gate that answers "yes, that is fine" and lets the handler go on to interpolate the
 * RAW string is one edit away from being decoration: the check and the emission are two
 * separate reads of the same variable, and only one of them is load-bearing. Returning the
 * `<...>` text means the handler physically cannot emit the unvalidated value — the thing
 * it has is the thing the gate produced. `TurtleIriRef` is branded so a plain string
 * cannot be passed where one is expected; the relay's `tsc --noEmit` step enforces that
 * before any test runs.
 *
 * ── WHY IT IS A SIBLING MODULE AND NOT AN INLINE `if` ────────────────────────
 *
 * The same reason `required-args.ts` and `supersession-frontier.ts` are: `server.ts`
 * starts an HTTP listener on import, so a refusal written inline there is a branch no unit
 * test can reach. The wire answer lives here so a test can assert on the wire answer.
 *
 * ── THE ENVELOPE IS `casRefusal`'s / `requiredArgsRefusal`'s ─────────────────
 *
 * Same `error` / `code` / `retryable` / `message` shape, so a client that already reads
 * those needs no new case. `retryable: false` and `code: 400` for the same reason
 * `requiredArgsRefusal` uses them: no number of retries turns `urn:x>` into an IRI. This
 * request cannot succeed; change it, don't resend it.
 */

import { turtleIriRef } from '@interego/core';

/**
 * A string that has already passed `turtleIriToken` — i.e. the complete `<...>` token,
 * angle brackets included, ready to interpolate.
 *
 * Branded so it cannot be confused with the raw argument it was derived from. The brand is
 * erased at runtime; its whole job is to make `writePublicReadAcl(url, ownerWebId)` — the
 * unchecked call — a compile error.
 */
export type TurtleIriRef = string & { readonly __turtleIriRef: unique symbol };

/** One argument that was supplied but cannot be an IRI reference. */
export interface UnusableIriArg {
  readonly name: string;
  /** What arrived, described so the caller can recognise its own value in it. */
  readonly received: string;
}

/** The refusal envelope — field-for-field the shape `requiredArgsRefusal` returns. */
export interface UnusableIriRefusal {
  readonly error: 'unusable_iri_argument';
  readonly code: number;
  readonly retryable: boolean;
  readonly message: string;
  readonly unusable: readonly UnusableIriArg[];
}

export type TurtleIriArgs<K extends string> =
  | { readonly ok: true; readonly refs: Readonly<Record<K, TurtleIriRef>>; readonly refusal?: undefined }
  | { readonly ok: false; readonly refs?: undefined; readonly refusal: UnusableIriRefusal };

/**
 * How much of an offending value is echoed back.
 *
 * `requiredArgsRefusal` echoes a whole mistyped scalar, and for its arguments that is
 * right. Here the value is frequently long — a WebID, a descriptor IRI, occasionally a
 * caller's entire payload pasted into the wrong field — and an unbounded echo puts the
 * caller's own body inside an error string AND inside the relay's logs. 120 characters is
 * enough for the prefix that makes a value recognisable.
 */
const ECHO_LIMIT = 120;

/**
 * Describe what arrived, in words the caller can match against what they sent.
 *
 * Strings are quoted with their (truncated) value because "you sent `urn:x> ; foo <bar`"
 * is actionable and "you sent a string" is a riddle. Non-strings are named by kind: a
 * value that is not a string at all cannot be recognised from its contents anyway, and
 * `JSON.stringify` of a whole graph object is the echo this deliberately avoids.
 */
function describeIriValue(value: unknown): string {
  if (typeof value === 'string') {
    const shown = value.length > ECHO_LIMIT ? `${value.slice(0, ECHO_LIMIT)}…` : value;
    return JSON.stringify(shown);
  }
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') return 'an object';
  return `${typeof value} (${String(value)})`;
}

/**
 * The scheme pasted onto a scheme-less value to ask `turtleIriRef` its OTHER question.
 *
 * `x` is a legal scheme per Turtle's grammar and carries no forbidden character of its
 * own, so the verdict on `x:<value>` is a verdict on `<value>` alone.
 */
const IRI_PROBE_SCHEME = 'x:';

/**
 * `value` as a complete Turtle IRI reference, or null if it cannot be written as one.
 *
 * ★ THIS IS THE DELIMITER HALF OF `turtleIriRef`, AND NOTHING ELSE — see the header. An
 * absolute value is answered by `turtleIriRef` itself, unchanged. A scheme-less one is
 * accepted when, and only when, the sole reason `turtleIriRef` refused it was the missing
 * scheme.
 *
 * ★ AND THERE IS NO SECOND COPY OF TURTLE'S FORBIDDEN-CHARACTER LIST HERE, DELIBERATELY.
 * `packages/core/src/rdf/escape.ts` owns that list; a duplicate in this file would agree
 * with it today and drift the moment the list grew — and the direction it would drift is
 * "the relay accepts a character core has decided is unwritable". So the question is asked
 * BY CALLING core again with a scheme pasted on: whatever it still refuses, it refuses for
 * the only reason it has left.
 */
function turtleIriToken(value: unknown): TurtleIriRef | null {
  const absolute = turtleIriRef(value);
  if (absolute !== null) return absolute as TurtleIriRef;
  // `<>` is a reference to the document itself, so an empty identifier would attribute a
  // record to the file it is written in. Not a value; refused with the rest.
  if (typeof value !== 'string' || value.length === 0) return null;
  if (turtleIriRef(`${IRI_PROBE_SCHEME}${value}`) === null) return null;
  // Assembled rather than interpolated, for the reason `tools/turtle-iri-ratchet.mjs`
  // assembles it in its own error reporter: the ratchet counts that literal text tree-wide,
  // and the one construction site that is safe BY CONSTRUCTION must not add to the
  // population the gate exists to shrink.
  return ('<' + value + '>') as TurtleIriRef;
}

/**
 * Serialize every named value as a Turtle IRI reference, or refuse the call.
 *
 * ALL-OR-NOTHING on purpose: a handler that got half its identifiers back would have to
 * decide, per identifier, whether to carry on without one — and "carry on without one" is
 * how a signed record ends up quietly saying less than it should. One verdict, and every
 * caller of this function has exactly one branch to write.
 *
 * `values` is keyed by the argument name AS THE CALLER SPELLS IT (`agent_id`, not
 * `agentId`), because the refusal names those keys and a caller cannot fix a field it has
 * never seen. Pass the EFFECTIVE value — the one that will actually be interpolated,
 * defaults applied — not the raw argument: several of these defaults are themselves built
 * out of other caller-supplied arguments, and the value that reaches the document is the
 * only one worth judging.
 *
 * ★ AND THAT CUTS BOTH WAYS, WHICH IS WHY THE RULE HERE MUST NOT TIGHTEN. The effective
 * value is frequently one the RELAY supplied, not one the caller sent — the session
 * identity, a default built from `pod_name`. Every refusal this function returns names a
 * caller-facing field and tells the caller to change it, so any condition that a
 * relay-minted value can fail turns into "a valid credential presenting as a caller
 * error", on a field the caller cannot even see. That is precisely what requiring a scheme
 * did. Refuse only what cannot be WRITTEN.
 */
export function turtleIriArgs<K extends string>(
  tool: string,
  values: Readonly<Record<K, unknown>>,
): TurtleIriArgs<K> {
  const refs = {} as Record<K, TurtleIriRef>;
  const unusable: UnusableIriArg[] = [];
  for (const name of Object.keys(values) as K[]) {
    const ref = turtleIriToken(values[name]);
    if (ref === null) unusable.push({ name, received: describeIriValue(values[name]) });
    else refs[name] = ref;
  }
  if (unusable.length === 0) return { ok: true, refs };

  const named = unusable.map(u => `\`${u.name}\` as ${u.received}`).join('; ');
  return {
    ok: false,
    refusal: {
      error: 'unusable_iri_argument',
      code: 400,
      retryable: false,
      unusable,
      message:
        `${tool} was called with ${named}. `
        + 'Each of these is written into this record as a Turtle IRI reference, and an IRI '
        + 'reference ends at the first ">". Turtle forbids < > " { } | ^ backtick backslash, '
        + 'space and every control character inside one and defines no escape for them — so '
        + 'there is no form of this value that could be written safely. Refused here rather '
        + 'than escaped or dropped: escaping an IRI is guessing, and omitting the triple '
        + 'would publish a record that silently says less than it claims. Resending will not '
        + 'help; send an identifier with none of those characters in it.',
    },
  };
}
