/**
 * @module http/retry
 * @description Substrate-level transient-network retry.
 *
 * Wraps any network call against the substrate (pod GETs/PUTs/POSTs,
 * WebSocket opens, federation HTTP) with bounded exponential backoff on
 * the classes of failure that are worth retrying — connection resets,
 * connect/socket timeouts, "fetch failed", and 5xx server responses.
 *
 * Non-transient errors (4xx other than 412, malformed responses,
 * signature failures, etc.) bypass the retry and surface immediately:
 * those are caller-fix problems, not "the network blinked" problems.
 *
 * Composition-pure — this introduces no new substrate concept and no
 * new ontology term. It is a network-layer resilience helper that
 * `publish()`, `discover()`, `fetchGraphContent()`, and `subscribe()`
 * call internally so every consumer gets retry without changing
 * their callsite. The existing manifest 412 If-Match CAS retry in
 * `publish()` is orthogonal — it handles concurrent-writer races —
 * and continues to live alongside this helper.
 *
 * The schedule (4 attempts, ~1s/2s/4s/8s; ~15s total ceiling) and the
 * transient pattern below are the contract documented in
 * `docs/PERSISTENT-AGENT-LOOP.md` ("Built-in resilience: withTransientRetry").
 * Keep both in sync — the code in this file is the source of truth.
 */

/** Options controlling withTransientRetry behavior. */
export interface TransientRetryOptions {
  /**
   * Maximum number of attempts (including the first try).
   * Default: 4. Setting maxAttempts=1 disables retry entirely.
   */
  readonly maxAttempts?: number;
  /**
   * Base delay in milliseconds for the exponential schedule.
   * Attempt N waits `baseMs * 2^(N-1)` before retrying.
   * Default: 1000 (→ 1s, 2s, 4s, 8s on attempts 1..4).
   */
  readonly baseMs?: number;
  /**
   * Optional observer fired once per retry attempt (after the failure,
   * before the backoff sleep). Receives the 1-based attempt index that
   * just failed and the error. Useful for logging from callers.
   */
  readonly onAttempt?: (attempt: number, error: unknown) => void;
}

// ── Transient-error matcher ─────────────────────────────────

/**
 * Patterns we treat as transient. These are the substrate-durable failures
 * — the kind where the right move is to wait a beat and try again. The
 * regex covers Node's undici errors, generic socket errors, and HTTP 5xx
 * status codes appearing inside thrown error messages (the pod clients
 * throw `Error("Failed to ...: 503 Service Unavailable")` style strings).
 */
const TRANSIENT_PATTERN = /ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT|UND_ERR_SOCKET|fetch failed/;

/**
 * A 5xx STATUS in a thrown message — not merely three digits that begin with a five.
 *
 * ── WHY THIS IS NOT `5\d\d` ──────────────────────────────────────────────────
 *
 * It was, unanchored, inside the alternation above. That fires on any such run ANYWHERE in the
 * message, including inside a longer number and inside a hex address. Measured on this
 * matcher: 59.3% of sha1-length hex addresses and 76.6% of sha256-length ones contain one.
 * This substrate addresses nearly everything by content hash, and the messages handed to this
 * function quote the address that failed — `followAffordance` throws
 * `Failed to fetch descriptor <url>: 403 Forbidden`. So a PERMANENT 403 or 404 on a
 * content-addressed descriptor was classified transient most of the time and retried four
 * times across ~15s of backoff, to be refused identically four times. `descriptor 1523 not
 * found`, `chunk of 512 bytes rejected` and `entry 2500 conflicts with head` all matched too,
 * and the last is worse than slow: resending a conflict re-collides.
 *
 * The status must therefore be INTRODUCED as one. Every site that throws these writes it the
 * same two ways — `...: 503 Service Unavailable` and `... returned 502 Bad Gateway` — so the
 * introducer is what is matched, and the trailing lookahead keeps it from biting off the head
 * of a longer number. A message that merely CONTAINS a number is not a status report.
 */
const HTTP_5XX_IN_MESSAGE = /(?:\bHTTP\b\s*|\bstatus\b\W{0,2}|\breturned\s+|:\s*)5\d\d(?![0-9A-Za-z])/i;

/** Undici exposes structured causes (`err.cause.code`) for some failures. */
const TRANSIENT_CAUSE_CODES: ReadonlySet<string> = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/**
 * Decide whether an error from a network call is worth retrying.
 *
 * Exported so callers wrapping their own fetch implementations can use
 * the same classification (e.g., deploy/ + Foxxi federation adapters
 * that want a single source of truth for "is this a transient blip").
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  // Structured undici cause first — most reliable signal when present.
  const cause = (err as { cause?: { code?: unknown } }).cause;
  if (cause && typeof cause === 'object') {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSIENT_CAUSE_CODES.has(code)) return true;
  }
  // Direct .code on the error itself (Node fs/net style).
  const directCode = (err as { code?: unknown }).code;
  if (typeof directCode === 'string' && TRANSIENT_CAUSE_CODES.has(directCode)) return true;
  // Message pattern — covers thrown Error strings from our pod clients
  // (`Failed to ...: 5xx ...`) plus the standard fetch/undici messages.
  const message = (err as { message?: unknown }).message;
  if (typeof message === 'string'
    && (TRANSIENT_PATTERN.test(message) || HTTP_5XX_IN_MESSAGE.test(message))) return true;
  return false;
}

// ── Core retry wrapper ──────────────────────────────────────

/**
 * Wrap a network call with exponential backoff on transient errors.
 *
 * Retries only on the signals the substrate is durable around
 * (see `isTransientNetworkError`). 4xx + parse errors + caller-domain
 * exceptions surface immediately — they are not transient.
 *
 * Default schedule: 4 attempts, 1s/2s/4s/8s backoff (~15s ceiling).
 * On exhaustion, throws the LAST observed error so callers see the
 * underlying network failure rather than a synthetic wrapper message.
 *
 * @example
 * ```ts
 * const body = await withTransientRetry(async () => {
 *   const r = await fetch(url);
 *   if (!r.ok) throw new Error(`Failed: ${r.status} ${r.statusText}`);
 *   return r.text();
 * });
 * ```
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  options: TransientRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseMs = options.baseMs ?? 1000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientNetworkError(err) || attempt === maxAttempts) {
        throw err;
      }
      if (options.onAttempt) {
        try {
          options.onAttempt(attempt, err);
        } catch {
          // Observer errors must never derail the retry loop.
        }
      }
      const backoff = baseMs * Math.pow(2, attempt - 1);
      await new Promise<void>(resolve => setTimeout(resolve, backoff));
    }
  }
  // Unreachable in practice — the loop above either returns or throws.
  // Present so TS knows the function always escapes.
  throw lastError;
}
