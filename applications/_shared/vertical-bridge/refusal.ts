/**
 * A declined call, shaped so the dispatcher next door can answer it honestly.
 *
 * ── WHY THIS IS SHARED AND NOT PER-VERTICAL ──────────────────────────────────
 *
 * `createVerticalBridge` derives an HTTP status from `kind` and `iep:refusalStatus`, and sets
 * MCP's `isError` from the same field. Every vertical mounted on it therefore has exactly one
 * way to decline — but until now that way was written out longhand in the foxxi bridge and
 * nowhere else, so the other verticals declined in whatever shape came to hand:
 *
 *   agp   `{ pending: 'situation-not-resolvable', note: 'The engine ran nothing …' }`
 *   owm   `{ ok: false, reason: 'refused: target host is private/loopback/link-local' }`
 *   wsp   `{ outcome: 'refused', reason: 'not-seated' }`
 *
 * All three answered HTTP 200. An audit found them after a source census had cleared the same
 * files, because a census keyed on words cannot anticipate a third, fourth and fifth spelling
 * of "no" — and `pending` shares no word with `error` or `reason` at all.
 *
 * The durable fix is not a wider regex. It is that declining has ONE import, so the next
 * vertical does not get to invent a sixth shape. What each site still chooses is the STATUS,
 * because only the site knows whether the caller's arguments were wrong (400), their identity
 * was missing (401) or insufficient (403), the thing named was absent (404), the state
 * conflicts (409), or the failure was ours (5xx).
 */

/** The shape `createVerticalBridge` reads. `kind` is what it keys on; it never sniffs. */
export interface BridgeRefusal {
  readonly kind: 'refusal';
  /** A sentence for a human. */
  readonly error: string;
  /** Why, in terms of the CALLER's situation — what they did or did not bring. */
  readonly 'iep:refusalReason'?: string;
  /** The HTTP status. Omit ONLY when the caller genuinely lacks a credential (the 401 default). */
  readonly 'iep:refusalStatus'?: number;
  /** The affordance that obtains what the caller lacks. A refusal that only says no is a dead end. */
  readonly 'iep:resolvedBy'?: Record<string, unknown>;
}

/** Build a refusal. `status` is required precisely so that choosing it is a decision. */
export function refuse(
  status: number,
  error: string,
  reason: string,
  resolvedBy?: Record<string, unknown>,
): BridgeRefusal {
  return {
    kind: 'refusal',
    'iep:refusalStatus': status,
    'iep:refusalReason': reason,
    error,
    ...(resolvedBy ? { 'iep:resolvedBy': resolvedBy } : {}),
  };
}

/** True when a handler result declares itself a refusal — the one test the dispatcher applies. */
export function isRefusal(result: unknown): result is BridgeRefusal {
  return Boolean(
    result && typeof result === 'object' && !Array.isArray(result)
      && (result as Record<string, unknown>)['kind'] === 'refusal',
  );
}
